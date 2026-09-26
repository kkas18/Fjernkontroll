// Feil som er ment for brukeren. Alt annet oversettes til en generell norsk melding
// og logges i Termux, slik at interne detaljer ikke lekker til grensesnittet.
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EADDRNOTAVAIL', 'ETIMEDOUT']);

export function toUserMessage(error) {
  if (error instanceof UserError) return { status: error.status, message: error.message, internal: false };
  const name = error?.name;
  const code = error?.code || error?.cause?.code;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return { status: 504, message: 'TV-en svarte ikke i tide. Sjekk at den er på og på samme Wi‑Fi.', internal: false };
  }
  if (name === 'SyntaxError') return { status: 400, message: 'Ugyldig forespørsel.', internal: false };
  if (NETWORK_CODES.has(code)) {
    return { status: 502, message: 'Fikk ikke kontakt med TV-en. Sjekk IP-adressen og nettverket.', internal: false };
  }
  return { status: 500, message: 'Noe gikk galt i broen. Se Termux for detaljer.', internal: true };
}
