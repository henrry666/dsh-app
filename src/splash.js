function render(state) {
  document.getElementById('message').textContent = state.message;
  document.getElementById('actions').hidden = state.phase !== 'error';
  document.body.classList.toggle('error', state.phase === 'error');
}
window.desktop.onState(render);
window.desktop.state().then(render);
document.getElementById('retry').onclick = () => window.desktop.retry();
document.getElementById('logs').onclick = () => window.desktop.logs();
