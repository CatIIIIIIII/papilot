import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransport, RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Store } from './store.ts';
import type { Device, People, Person } from '../shared.ts';

// People who sign in at the public URL, their passkeys, invites and browser
// sessions. None of these writes emit the store's change event: every change
// makes each open workspace reload its state, which would itself touch a session.
export interface User { id: string; name: string; role: 'owner' | 'member'; handle: string; createdAt: number; lastSeenAt: number | null }
interface Credential { id: string; userId: string; publicKey: string; counter: number; transports?: string[]; label: string; createdAt: number; lastUsedAt: number | null }
interface Invite { userId: string; createdAt: number }
export interface Session { id: string; userId: string; csrf: string; label: string; createdAt: number; seenAt: number; expires: number }
interface Challenge { type: 'register' | 'authenticate'; invite?: string; userId?: string; expires: number }

const MINUTE = 60000, DAY = 1440 * MINUTE;
// A session slides for 30 days of use and ends 90 days after sign-in regardless.
const SESSION = 30 * DAY, SESSION_LIMIT = 90 * DAY, SEEN = 10 * MINUTE;
// An owner invite signs in as the owner from anywhere, so it is short-lived.
const INVITE = { member: 7 * DAY, owner: 15 * MINUTE }, CHALLENGE = 5 * MINUTE, CHALLENGES = 1000;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

export class AccountError extends Error { statusCode = 400 }

// The passkey ceremonies, which tests replace with fakes.
export const ceremonies = { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse };

export class Accounts extends EventEmitter {
  private challenges = new Map<string, Challenge>();
  constructor(private store: Store, readonly origin: string | null, private passkeys = ceremonies, private now = () => Date.now()) {
    super();
    if (!this.users().some(user => user.role === 'owner')) this.saveUser({ id: randomUUID(), name: os.userInfo().username || 'Owner', role: 'owner', handle: secret(), createdAt: this.now(), lastSeenAt: null });
    this.purge();
  }
  private get db() { return this.store.db; }
  private rows<T>(sql: string, ...values: (string | number)[]) { return (this.db.prepare(sql).all(...values) as { data: string }[]).map(row => JSON.parse(row.data) as T); }
  users() { return this.rows<User>('SELECT data FROM users ORDER BY rowid'); }
  user(id: string) { return this.users().find(user => user.id === id); }
  owner() { return this.users().find(user => user.role === 'owner')!; }
  private saveUser(user: User) { this.db.prepare('INSERT INTO users VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(user.id, JSON.stringify(user)); return user; }
  private member(id: string) {
    const user = this.user(id);
    if (!user) throw new AccountError('This person is no longer in Papilot.');
    return user;
  }
  projects(userId: string) { return (this.db.prepare('SELECT project_id FROM members WHERE user_id=? ORDER BY project_id').all(userId) as { project_id: string }[]).map(row => row.project_id); }
  // Read on every request, so unsharing a paper takes effect at once.
  canSee(user: User, projectId: string) { return user.role === 'owner' || Boolean(this.db.prepare('SELECT 1 FROM members WHERE project_id=? AND user_id=?').get(projectId, user.id)); }
  private credentials(userId: string) { return this.rows<Credential>('SELECT data FROM credentials WHERE user_id=? ORDER BY rowid', userId); }
  private sessions(userId: string) { return this.rows<Session>('SELECT data FROM sessions WHERE user_id=? AND expires>? ORDER BY rowid', userId, this.now()); }

  people(): People {
    const devices = (user: User): Device[] => [
      ...this.credentials(user.id).map(c => ({ id: c.id, kind: 'passkey' as const, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
      ...this.sessions(user.id).map(s => ({ id: s.id, kind: 'session' as const, label: s.label, createdAt: s.createdAt, lastUsedAt: s.seenAt })),
    ];
    const person = (user: User): Person => ({ id: user.id, name: user.name, role: user.role, joined: this.credentials(user.id).length > 0, projects: user.role === 'owner' ? [] : this.projects(user.id), lastSeenAt: user.lastSeenAt, devices: devices(user) });
    return { origin: this.origin, people: this.users().map(person) };
  }
  // A new person sees the chosen papers once they open their invite.
  addPerson(name: string, projects: string[]) {
    const user = this.saveUser({ id: randomUUID(), name, role: 'member', handle: secret(), createdAt: this.now(), lastSeenAt: null });
    this.share(user.id, projects);
    return { id: user.id, link: this.invite(user.id) };
  }
  rename(userId: string, name: string) { this.saveUser({ ...this.member(userId), name }); }
  share(userId: string, projects: string[]) {
    if (this.member(userId).role === 'owner') throw new AccountError('The owner sees every paper.');
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM members WHERE user_id=?').run(userId);
      for (const project of new Set(projects)) this.db.prepare('INSERT INTO members VALUES(?,?)').run(project, userId);
    });
    this.emit('revoked', { userId });
  }
  // One link registers one passkey: a new person's first, or another device's.
  invite(userId: string) {
    const user = this.member(userId);
    if (!this.origin) throw new AccountError('Set PAPILOT_ACCOUNT_ORIGIN to the public URL before inviting people.');
    const token = secret(), invite: Invite = { userId, createdAt: this.now() };
    this.db.prepare('INSERT INTO invites VALUES(?,?,?,?)').run(digest(token), userId, this.now() + INVITE[user.role], JSON.stringify(invite));
    return `${this.origin}/invite#${token}`;
  }
  remove(userId: string) {
    if (this.member(userId).role === 'owner') throw new AccountError('The owner cannot be removed.');
    this.store.transaction(() => {
      for (const table of ['credentials', 'invites', 'sessions', 'members', 'preferences']) this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
      this.db.prepare('DELETE FROM users WHERE id=?').run(userId);
    });
    for (const [key, challenge] of this.challenges) if (challenge.userId === userId) this.challenges.delete(key);
    this.emit('revoked', { userId });
  }
  // A lost device: its passkey or its signed-in session.
  revoke(userId: string, deviceId: string) {
    const removed = Number(this.db.prepare('DELETE FROM credentials WHERE id=? AND user_id=?').run(deviceId, userId).changes)
      + Number(this.db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(deviceId, userId).changes);
    if (!removed) throw new AccountError('This device is no longer signed in.');
    this.emit('revoked', { userId, sessionId: deviceId });
  }
  signOutEverywhere(userId: string) {
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
    this.emit('revoked', { userId });
  }

  private startSession(userId: string, label: string) {
    const token = secret(), now = this.now();
    const session: Session = { id: randomUUID(), userId, csrf: secret(), label, createdAt: now, seenAt: now, expires: now + SESSION };
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(token), session.id, userId, session.expires, JSON.stringify(session));
    return { token, session };
  }
  // The signed-in person for a session cookie. Use slides the expiry, but at
  // most every ten minutes, so ordinary polling does not write.
  session(token: string) {
    if (!token) return null;
    const hash = digest(token), now = this.now();
    const row = this.db.prepare('SELECT data FROM sessions WHERE token_hash=? AND expires>?').get(hash, now) as { data: string } | undefined;
    if (!row) return null;
    let session = JSON.parse(row.data) as Session;
    const user = this.user(session.userId);
    if (!user) return null;
    if (now - session.seenAt > SEEN) {
      session = { ...session, seenAt: now, expires: Math.min(now + SESSION, session.createdAt + SESSION_LIMIT) };
      this.db.prepare('UPDATE sessions SET expires=?, data=? WHERE token_hash=?').run(session.expires, JSON.stringify(session), hash);
      this.saveUser({ ...user, lastSeenAt: now });
    }
    return { session, user };
  }
  endSession(sessionId: string) { this.db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId); this.emit('revoked', { sessionId }); }
  purge() {
    this.db.prepare('DELETE FROM invites WHERE expires<=?').run(this.now());
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.now());
  }

  private get rpID() {
    if (!this.origin) throw new AccountError('Sign-in is not set up on this Papilot.');
    return new URL(this.origin).hostname;
  }
  private remember(challenge: string, value: Omit<Challenge, 'expires'>) {
    const now = this.now();
    for (const [key, entry] of this.challenges) if (entry.expires <= now) this.challenges.delete(key);
    while (this.challenges.size >= CHALLENGES) this.challenges.delete(this.challenges.keys().next().value!);
    this.challenges.set(challenge, { ...value, expires: now + CHALLENGE });
  }
  // Each challenge is used once, whatever the ceremony's outcome.
  private take(challenge: string) {
    const entry = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    return entry && entry.expires > this.now() ? entry : undefined;
  }
  private openInvite(token: string) {
    const hash = digest(String(token || ''));
    const row = this.db.prepare('SELECT user_id FROM invites WHERE token_hash=? AND expires>?').get(hash, this.now()) as { user_id: string } | undefined;
    const user = row && this.user(row.user_id);
    if (!user) throw new AccountError('This invite link has expired or was already used. Ask for a new one.');
    return { hash, user };
  }
  inviteInfo(token: string, paperName: (id: string) => string | undefined) {
    const { user } = this.openInvite(token);
    return { name: user.name, owner: user.role === 'owner', inviter: this.owner().name, papers: this.projects(user.id).map(paperName).filter(Boolean), adding: this.credentials(user.id).length > 0 };
  }
  async registrationOptions(token: string) {
    const { hash, user } = this.openInvite(token);
    const options = await this.passkeys.generateRegistrationOptions({
      rpName: 'Papilot', rpID: this.rpID, userName: user.name, userDisplayName: user.name, userID: isoBase64URL.toBuffer(user.handle),
      attestationType: 'none', excludeCredentials: this.credentials(user.id).map(c => ({ id: c.id, transports: c.transports as AuthenticatorTransport[] | undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    this.remember(options.challenge, { type: 'register', invite: hash, userId: user.id });
    return options;
  }
  async register(token: string, response: RegistrationResponseJSON, label: string) {
    const { hash } = this.openInvite(token);
    let bound: Challenge | undefined;
    const result = await this.passkeys.verifyRegistrationResponse({
      response, expectedOrigin: this.origin!, expectedRPID: this.rpID, requireUserVerification: true,
      expectedChallenge: challenge => { bound = this.take(challenge); return bound?.type === 'register' && bound.invite === hash; },
    }).catch(() => ({ verified: false as const }));
    if (!result.verified || !bound?.userId) throw new AccountError('The passkey could not be created. Try again.');
    const { credential } = result.registrationInfo, userId = bound.userId;
    // Verification awaited; using the invite, saving the passkey and signing in
    // happen together or not at all, so one link cannot register twice.
    return this.store.transaction(() => {
      if (Number(this.db.prepare('DELETE FROM invites WHERE token_hash=? AND expires>?').run(hash, this.now()).changes) !== 1) throw new AccountError('This invite link has expired or was already used. Ask for a new one.');
      if (!this.user(userId)) throw new AccountError('This person is no longer in Papilot.');
      const saved: Credential = { id: credential.id, userId, publicKey: isoBase64URL.fromBuffer(credential.publicKey), counter: credential.counter, transports: credential.transports, label, createdAt: this.now(), lastUsedAt: null };
      this.db.prepare('INSERT INTO credentials VALUES(?,?,?)').run(saved.id, userId, JSON.stringify(saved));
      return this.startSession(userId, label);
    });
  }
  async authenticationOptions() {
    const options = await this.passkeys.generateAuthenticationOptions({ rpID: this.rpID, userVerification: 'required', allowCredentials: [] });
    this.remember(options.challenge, { type: 'authenticate' });
    return options;
  }
  async authenticate(response: AuthenticationResponseJSON, label: string) {
    const failed = () => new AccountError('This passkey could not sign you in. Ask the owner for a new invite if it was removed.');
    const row = this.db.prepare('SELECT data FROM credentials WHERE id=?').get(String(response?.id || '')) as { data: string } | undefined;
    const credential = row && JSON.parse(row.data) as Credential, user = credential && this.user(credential.userId);
    // A discoverable passkey names its user; it must be the user it was registered to.
    if (!credential || !user || response.response?.userHandle !== user.handle) throw failed();
    let bound: Challenge | undefined;
    const result = await this.passkeys.verifyAuthenticationResponse({
      response, expectedOrigin: this.origin!, expectedRPID: this.rpID, requireUserVerification: true,
      credential: { id: credential.id, publicKey: isoBase64URL.toBuffer(credential.publicKey), counter: credential.counter, transports: credential.transports },
      expectedChallenge: challenge => { bound = this.take(challenge); return bound?.type === 'authenticate'; },
    }).catch(() => ({ verified: false as const }));
    if (!result.verified || !bound) throw failed();
    return this.store.transaction(() => {
      if (!this.user(user.id) || !this.db.prepare('SELECT 1 FROM credentials WHERE id=?').get(credential.id)) throw failed();
      const used: Credential = { ...credential, counter: result.authenticationInfo.newCounter, lastUsedAt: this.now() };
      this.db.prepare('UPDATE credentials SET data=? WHERE id=?').run(JSON.stringify(used), credential.id);
      return this.startSession(user.id, label);
    });
  }
}

// A short name for the browser a session or passkey came from.
export function deviceLabel(agent: string | undefined) {
  const ua = agent || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}
