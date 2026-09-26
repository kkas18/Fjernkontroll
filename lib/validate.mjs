import { UserError } from './errors.mjs';

export const COMMANDS = Object.freeze([
  'Up', 'Down', 'Left', 'Right', 'Select', 'Back', 'Home',
  'VolumeUp', 'VolumeDown', 'Mute', 'PowerOff',
  'Play', 'Pause', 'Rewind', 'FastForward', 'ChannelUp', 'ChannelDown',
]);

export const MAX_TEXT_LENGTH = 140;

// Kun private IPv4-nett (RFC 1918). Hindrer at broen brukes mot internett eller loopback.
export function isPrivateIPv4(ip) {
  if (typeof ip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const parts = ip.split('.').map(Number);
  if (!parts.every((n) => n >= 0 && n <= 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function validDevice(input) {
  if (!input || !['roku', 'lg'].includes(input.type) || !isPrivateIPv4(input.host)) {
    throw new UserError('Oppgi en gyldig lokal IP-adresse og TV-type.');
  }
  const fallback = input.type === 'lg' ? 'LG webOS' : 'Roku';
  const name = String(input.name || fallback).trim().slice(0, 70) || fallback;
  return { type: input.type, host: input.host, name };
}

export function validCommand(key) {
  const value = String(key ?? '');
  if (!COMMANDS.includes(value)) throw new UserError('Ukjent kommando.');
  return value;
}

export function validText(text) {
  const value = String(text ?? '').slice(0, MAX_TEXT_LENGTH);
  if (!value.trim()) throw new UserError('Skriv inn tekst først.');
  return value;
}
