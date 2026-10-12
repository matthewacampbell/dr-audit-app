// How a person is shown around the app: "Name Surname", or their username if no name is set yet.

// For SQL: displayNameSql('u') -> an expression to SELECT, e.g.  displayNameSql('u') + ' AS author'
const displayNameSql = (alias = 'u') =>
  `COALESCE(NULLIF(TRIM(COALESCE(${alias}.first_name, '') || ' ' || COALESCE(${alias}.last_name, '')), ''), ${alias}.username)`;

function displayName(user) {
  const full = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  return full || user.username;
}

function initials(user) {
  const first = (user.first_name || '').trim();
  const last = (user.last_name || '').trim();
  if (first && last) return (first[0] + last[0]).toUpperCase();
  return displayName(user).slice(0, 2).toUpperCase();
}

module.exports = { displayNameSql, displayName, initials };
