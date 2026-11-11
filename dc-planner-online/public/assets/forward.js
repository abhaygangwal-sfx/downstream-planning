/* Invite and password-reset emails land on the Site URL. Send them to the set-password page. */
(function () {
  var h = location.hash || '', q = location.search || '';
  if (/type=(invite|recovery|signup|magiclink)/.test(h + q) || /[?&]code=/.test(q) || /access_token=/.test(h)) {
    location.replace('reset.html' + q + h);
  }
})();
