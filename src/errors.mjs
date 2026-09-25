// Typed domain error: every rejected operation carries a machine-readable code
// so the UI can render a specific state instead of hiding buttons.
export class LedgerError extends Error {
  constructor(code, message, {status = 409, details} = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}
