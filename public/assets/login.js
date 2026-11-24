const $ = (sel) => document.querySelector(sel);
const form = $('#authForm');
let mode = 'login'; // login | register | setup
let config = { setupRequired: false, registrationOpen: false };

const COPY = {
  login: { title: 'Sign in', sub: 'Welcome back. Sign in to see your businesses.', submit: 'Sign in', switchText: 'New here?', switchBtn: 'Create an account' },
  register: { title: 'Create your account', sub: 'Your businesses and transactions are private to you.', submit: 'Create account', switchText: 'Already have an account?', switchBtn: 'Sign in' },
  setup: { title: 'Set up Ledgerly', sub: 'Create the first account. It will be the administrator of this server and can invite others.', submit: 'Create admin account' },
};

function setMode(next) {
  mode = next;
  const c = COPY[mode];
  $('#authTitle').textContent = c.title;
  $('#authSub').textContent = c.sub;
  $('#authSubmit').textContent = c.submit;
  document.title = `${c.title} · Ledgerly`;
  const creating = mode !== 'login';
  $('#confirmField').hidden = !creating;
  $('#password').autocomplete = creating ? 'new-password' : 'current-password';
  $('#authSwitch').hidden = mode === 'setup' || !config.registrationOpen;
  if (c.switchText) {
    $('#switchText').textContent = c.switchText;
    $('#switchBtn').textContent = c.switchBtn;
  }
  showError('');
}

function showError(msg) {
  const el = $('#authAlert');
  el.textContent = msg;
  el.hidden = !msg;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

$('#switchBtn').addEventListener('click', () => {
  setMode(mode === 'login' ? 'register' : 'login');
  $('#username').focus();
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const username = $('#username').value.trim();
  const password = $('#password').value;
  if (!username || !password) { showError('Please enter your username and password.'); return; }
  if (mode !== 'login') {
    if (password.length < 8) { showError('Passwords need at least 8 characters.'); return; }
    if (password !== $('#confirm').value) { showError('The two passwords don’t match.'); $('#confirm').focus(); return; }
  }
  const btn = $('#authSubmit');
  btn.disabled = true;
  showError('');
  try {
    await post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { username, password });
    location.replace('/');
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    (mode === 'login' ? $('#password') : $('#username')).focus();
  }
});

(async () => {
  try {
    const res = await fetch('/api/auth/config', { headers: { Accept: 'application/json' } });
    config = await res.json();
  } catch { /* fall back to plain sign in */ }
  setMode(config.setupRequired ? 'setup' : 'login');
  $('#username').focus();
})();
