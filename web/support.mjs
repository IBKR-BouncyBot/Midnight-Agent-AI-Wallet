const address = document.querySelector('#support-address');
const copyButton = document.querySelector('#support-copy');
const status = document.querySelector('#support-copy-status');

if (address && copyButton && status) {
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(address.value.trim());
      status.textContent = 'Address copied. Thank you for supporting the project!';
    } catch {
      address.focus();
      address.select();
      status.textContent = 'Address selected. Use your device’s copy command to copy it.';
    }
  });
}
