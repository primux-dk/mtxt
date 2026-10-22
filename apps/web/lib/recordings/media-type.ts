/**
 * An audio or video MIME type, with optional parameters. The audio route
 * sends it back as Content-Type, so nothing else may get in: `text/html`
 * would run as a page on the app's own origin.
 */
export const isMediaType = (value: string) =>
  value.length <= 200 &&
  /^(audio|video)\/[a-z0-9][a-z0-9.+-]*(\s*;\s*[a-z0-9-]+=("[^"]*"|[^;"\s]+))*$/i.test(value);
