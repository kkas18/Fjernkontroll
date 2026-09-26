import { UserError } from './errors.mjs';

export const COMMANDS = Object.freeze([
  'Up', 'Down', 'Left', 'Right', 'Select', 'Back', 'Home',
  'VolumeUp', 'VolumeDown', 'Mute', 'PowerOff',
  'Play', 'Pause', 'PlayPause', 'Rewind', 'FastForward', 'ChannelUp', 'ChannelDown',
  'PowerOn', 'Backspace', 'Enter',
  'Num0', 'Num1', 'Num2', 'Num3', 'Num4', 'Num5', 'Num6', 'Num7', 'Num8', 'Num9',
  'Red', 'Green', 'Yellow', 'Blue',
  'Info', 'Guide', 'List', 'Dash', 'Exit', 'Settings', 'Subtitles', 'Teletext', 'Aspect', 'Recent',
  'Search', 'Replay',
]);

export const MAX_QUERY_LENGTH = 100;

export function validQuery(query) {
  const value = String(query ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  if (!value) throw new UserError('Skriv hva du vil søke etter.');
  return value;
}

export function validInputId(id) {
  const value = String(id ?? '');
  if (!/^[\w.:-]{1,80}$/.test(value)) throw new UserError('Ukjent inngang.');
  return value;
}

export const MAX_APPS = 48;

export function validAppId(id) {
  const value = String(id ?? '');
  if (!/^[\w.:-]{1,80}$/.test(value)) throw new UserError('Ukjent app.');
  return value;
}

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
