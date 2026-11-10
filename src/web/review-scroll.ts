// Keep wheel scrolling inside the review even after a decision changes the
// iframe's scroll layers: the browser could keep sending the next wheel
// gestures to Chat, the element it retained from an earlier gesture.
//
// The review itself scrolls natively, on the compositor: a listener that may
// cancel wheel events makes every scroll wait for the page's main thread,
// which stalled scrolling whenever the review was busy. So the redirect is
// armed only by a click or key in the review, the moments that replace its
// scroll layers, and ends with the first wheel that reaches the review.
export function installReviewScroll(frame: HTMLIFrameElement, doc: Document) {
  const host = frame.ownerDocument;
  let armed = false;
  const scroll = (event: WheelEvent, x: number, y: number) => {
    if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey) return;
    const paper = doc.getElementById('paper'), hit = doc.elementFromPoint(x, y);
    if (!paper || !hit || !paper.contains(hit) || hit.closest('select')) return;
    const view = doc.defaultView!;
    const line = parseFloat(view.getComputedStyle(hit).lineHeight) || 16;
    const factorX = event.deltaMode === 1 ? line : event.deltaMode === 2 ? paper.clientWidth : 1;
    const factorY = event.deltaMode === 1 ? line : event.deltaMode === 2 ? paper.clientHeight : 1;
    const dx = event.shiftKey && !event.deltaX ? event.deltaY * factorX : event.deltaX * factorX;
    const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY * factorY;
    if (!dx && !dy) return;
    event.preventDefault();
    // Textareas and source excerpts keep their own scrolling. Once they reach
    // an edge, only the paper can take over; never the surrounding workspace.
    for (const [axis, delta] of [['x', dx], ['y', dy]] as const) {
      if (!delta) continue;
      for (let element: Element | null = hit; element; element = element.parentElement) {
        const style = view.getComputedStyle(element);
        const overflow = axis === 'x' ? style.overflowX : style.overflowY;
        const position = axis === 'x' ? element.scrollLeft : element.scrollTop;
        const extent = axis === 'x' ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
        if (/^(auto|scroll)$/.test(overflow) && extent > 0) {
          if (delta < 0 ? position > 0 : position < extent - 1) {
            element.scrollBy({ [axis === 'x' ? 'left' : 'top']: delta, behavior: 'instant' });
            break;
          }
          if (['contain', 'none'].includes(axis === 'x' ? style.overscrollBehaviorX : style.overscrollBehaviorY)) break;
        }
        if (element === paper) break;
      }
    }
  };
  const outside = (event: WheelEvent) => {
    // A wheel gesture can still target Chat after the pointer enters the
    // iframe. Only forward it if the iframe is actually under the pointer;
    // toolbars, popovers and dialogs must keep their normal behavior.
    if (host.elementFromPoint(event.clientX, event.clientY) !== frame) return;
    const box = frame.getBoundingClientRect();
    scroll(event, (event.clientX - box.left) * frame.clientWidth / box.width, (event.clientY - box.top) * frame.clientHeight / box.height);
  };
  const arm = () => {
    if (armed) return;
    armed = true;
    host.addEventListener('wheel', outside, { passive: false, capture: true });
  };
  const disarm = () => {
    if (!armed) return;
    armed = false;
    host.removeEventListener('wheel', outside, true);
  };
  doc.addEventListener('pointerdown', arm, { passive: true, capture: true });
  doc.addEventListener('keydown', arm, { passive: true, capture: true });
  doc.addEventListener('wheel', disarm, { passive: true });
  return () => {
    disarm();
    doc.removeEventListener('pointerdown', arm, true);
    doc.removeEventListener('keydown', arm, true);
    doc.removeEventListener('wheel', disarm);
  };
}
