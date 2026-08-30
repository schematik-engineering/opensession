function accountForContext(accounts, activeId, assignedId, currentUrl) {
  const assigned = accounts.find((account) => account.id === assignedId);
  if (assigned) return assigned;
  try {
    const origin = new URL(currentUrl || "").origin;
    const navigated = accounts.find(
      (account) => new URL(account.url).origin === origin,
    );
    if (navigated) return navigated;
  } catch {}
  return accounts.find((account) => account.id === activeId) || null;
}

function resumableAccountUrl(accountUrl, candidate) {
  if (!candidate) return null;
  try {
    const account = new URL(accountUrl);
    const target = new URL(candidate);
    if (!/^https?:$/.test(target.protocol) || target.origin !== account.origin)
      return null;
    return target.toString();
  } catch {
    return null;
  }
}

module.exports = { accountForContext, resumableAccountUrl };
