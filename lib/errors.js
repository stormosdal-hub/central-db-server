'use strict';
// En feil med HTTP-status. Feilsvaret blir { "error": "tekst" } (PROTOKOLL.md §2).
class HttpError extends Error {
  constructor(statusCode, message, extra) {
    super(message);
    this.statusCode = statusCode;
    if (extra) Object.assign(this, extra);
  }
}
const bad = (message, extra) => new HttpError(400, message, extra);

module.exports = { HttpError, bad };
