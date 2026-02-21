export const getLocationSearch = (): string => {
  if (typeof window === 'undefined') return '';

  if (window.location.search) {
    return window.location.search;
  }

  const hash = window.location.hash || '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex >= 0) {
    return hash.slice(queryIndex);
  }

  return '';
};
