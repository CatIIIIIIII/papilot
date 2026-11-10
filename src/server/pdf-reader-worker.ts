import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import type { Annotation } from '../shared.ts';
import { AnnotationPages, placeAnnotation, type AnnotationPlacement } from './annotation-placement.ts';
import { locateMark, type LineOp, type MarkRequest } from './note-location.ts';

const { engine } = workerData as { engine: string };
const [{ PdfDocument, containsCenter }, { opcodesWithin }] = await Promise.all([
  import(pathToFileURL(path.join(engine, 'src/render/pdf.ts')).href),
  import(pathToFileURL(path.join(engine, 'src/core/diff.ts')).href),
]);
type Document = InstanceType<typeof PdfDocument>;

// The documents one request reads, each opened once and closed at its end.
async function reading<T>(work: (open: (file: string) => Document) => Promise<T>) {
  const documents = new Map<string, Document>();
  try {
    return await work(file => {
      let document = documents.get(file);
      if (!document) documents.set(file, document = new PdfDocument(file));
      return document;
    });
  } finally { for (const document of documents.values()) document.close(); }
}

const operations = {
  locate: (request: MarkRequest) => reading(open => locateMark(open(request.pdf), request, { containsCenter, opcodesWithin: opcodesWithin as (a: string[], b: string[], timeout: number) => LineOp[] | null })),
  // Notes from earlier PDFs, placed on the current one. A note whose place
  // cannot be verified, or whose PDF cannot be read, stays where it was.
  place: ({ current, notes }: { current: string; notes: { note: Annotation; previous: string }[] }) => reading(async open => {
    const pages = new Map<string, AnnotationPages>(), of = (file: string) => {
      let found = pages.get(file);
      if (!found) pages.set(file, found = new AnnotationPages(open(file)));
      return found;
    };
    const target = of(current), placed: (AnnotationPlacement | null)[] = [];
    for (const { note, previous } of notes) {
      try { placed.push(await placeAnnotation(note, of(previous), target)); }
      catch { placed.push(null); }
    }
    return placed;
  }),
};

parentPort!.on('message', async ({ id, op, args }: { id: number; op: keyof typeof operations; args: never }) => {
  try { parentPort!.postMessage({ id, value: await operations[op](args) }); }
  catch (error) { parentPort!.postMessage({ id, error: (error as Error)?.message || String(error) }); }
});
