// relay/public/js/login.js — 登录页面逻辑

async function login() {
  const password = document.getElementById('password').value;
  const btn = document.getElementById('loginBtn');
  const errorEl = document.getElementById('errorMsg');

  btn.disabled = true;
  btn.textContent = '登录中...';
  errorEl.classList.add('hidden');

  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const data = await res.json();

    if (data.ok) {
      localStorage.setItem('token', data.token);
      window.location.href = '/app';
    } else {
      errorEl.textContent = data.error || '登录失败';
      errorEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = '登录';
    }
  } catch (err) {
    errorEl.textContent = '无法连接到服务器';
    errorEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

// 回车登录
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !document.getElementById('loginBtn').disabled) {
    login();
  }
});
