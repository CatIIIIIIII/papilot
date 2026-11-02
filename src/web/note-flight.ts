// Notes taken out of a task fly back to the My notes button, which then shows
// how many it received, so the reader sees where they went. On a phone the
// PDF view's button stands in while the PDF and its toolbar are hidden.
const settling = new WeakMap<HTMLElement, number>();

function visible(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
}

function home() {
  return ['library', 'pdf'].map(place => document.querySelector<HTMLElement>(`[data-notes-home="${place}"]`)).find(element => element && visible(element)) || null;
}

function receive(target: HTMLElement, count: number) {
  clearTimeout(settling.get(target));
  target.classList.remove('notes-received');
  void target.offsetWidth; // Restart the pop when more notes arrive.
  target.dataset.received = `+${count}`;
  target.classList.add('notes-received');
  settling.set(target, window.setTimeout(() => { target.classList.remove('notes-received'); delete target.dataset.received; }, 1600));
}

export function returnNotes(cards: HTMLElement[]) {
  const target = home();
  if (!target || !cards.length) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { receive(target, cards.length); return; }
  const destination = target.getBoundingClientRect(), duration = 680;
  const flights = cards.slice(0, 5).flatMap((card, index) => {
    const box = card.getBoundingClientRect();
    if (!box.width || !box.height) return [];
    const ghost = card.cloneNode(true) as HTMLElement;
    ghost.classList.add('note-flight');
    ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
    ghost.style.width = `${box.width}px`; ghost.style.height = `${box.height}px`;
    document.body.append(ghost);
    // The card shrinks onto the button's centre along a shallow arc.
    const scale = Math.min(destination.width / box.width, destination.height / box.height);
    const start = { x: box.left, y: box.top };
    const end = { x: destination.left + (destination.width - box.width * scale) / 2, y: destination.top + (destination.height - box.height * scale) / 2 };
    const arc = Math.min(110, Math.hypot(end.x - start.x, end.y - start.y) * .16 + 24);
    const frames = [0, .1, .3, .55, .8, 1].map(progress => {
      const travel = Math.max(0, (progress - .1) / .9), shrink = travel * travel;
      const x = start.x + (end.x - start.x) * travel;
      const y = Math.max(4, start.y + (end.y - start.y) * travel - Math.sin(travel * Math.PI) * arc);
      return { offset: progress, transform: `translate(${x}px, ${y}px) rotate(${-4 * Math.sin(travel * Math.PI)}deg) scale(${1 + (scale - 1) * shrink})`, opacity: 1 - .85 * Math.pow(travel, 5) };
    });
    const animation = ghost.animate(frames, { duration, delay: index * 70, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' });
    const land = () => ghost.remove();
    void animation.finished.then(land, land);
    // A hidden tab can hold the animation; never leave a card on screen.
    window.setTimeout(land, duration + index * 70 + 1000);
    return [animation];
  });
  if (!flights.length) { receive(target, cards.length); return; }
  const arrive = () => receive(target, cards.length);
  void flights[0].finished.then(arrive, arrive);
}
