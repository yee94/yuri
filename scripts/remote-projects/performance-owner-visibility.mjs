// DOM eligibility only. Actual frame pixels still require independent review.
export function ownerNodeVisible(node, document) {
  if (document.getElementById('initial-loading')) return false;
  const view = document.defaultView;
  const rect = node.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
    const style = view.getComputedStyle(ancestor);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
  }
  if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= view.innerHeight || rect.left >= view.innerWidth) return false;
  const x = Math.max(0, Math.min(view.innerWidth - 1, rect.left + rect.width / 2));
  const y = Math.max(0, Math.min(view.innerHeight - 1, rect.top + rect.height / 2));
  const top = document.elementFromPoint(x, y);
  return !!top && (node.contains(top) || top.contains(node));
}
