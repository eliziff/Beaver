let element, timer;
export function autoFetchToast(count) {
  if (!count) return;
  if (!element) {
    element = document.createElement('div');
    element.setAttribute('role', 'status');
    Object.assign(element.style, {position:'fixed',bottom:'24px',left:'50%',transform:'translateX(-50%)',zIndex:'10000',maxWidth:'calc(100vw - 32px)',padding:'12px 18px',border:'1px solid #d1d5db',borderRadius:'8px',background:'white',color:'#111827',boxShadow:'0 4px 16px #0002',font:'14px system-ui'});
    document.body.append(element);
  }
  element.textContent = `Auto-fetched ${count} PDF${count === 1 ? '' : 's'}`;
  clearTimeout(timer);
  timer = setTimeout(() => { element.remove(); element = undefined; }, 5000);
}
