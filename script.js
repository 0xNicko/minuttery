const toggleButton = document.getElementById('toggleTheme');
const statusText = document.getElementById('statusText');

const setTheme = () => {
  const isLight = document.body.classList.toggle('light');
  statusText.textContent = isLight ? 'Modo claro' : 'Listo';
};

toggleButton.addEventListener('click', setTheme);
