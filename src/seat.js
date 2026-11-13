// Blind seat tokens (blind BLS signatures on BLS12-381).
//
// The host signs a seat for a handle WITHOUT seeing which handle it is:
//   member:  P = hash(seat message for my handle);  B = P * r      (r is a random secret)
//   host:    S' = B * sk                                            (signs the blinded point)
//   member:  S = S' * (1/r)                                         (removes the blinding)
// S is an ordinary BLS signature on the handle, which anyone can check
// against the network's public seat key. The host never saw P or S.
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha512 } from '@noble/hashes/sha2.js';

const sig = bls.shortSignatures;   // signatures in G1 (48 bytes), public key in G2 (96 bytes)
const Fr = bls.fields.Fr;
const enc = new TextEncoder();

const seatMessage = (era, handle) => enc.encode('fkn-seat|' + era + '|' + handle);
const toBig = (bytes) => BigInt('0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));

function g1(hex) {
  const p = sig.Signature.fromHex(hex);
  p.assertValidity();
  if (p.is0()) throw new Error('zero point');
  return p;
}

// The host's seat-signing secret, derived from the host key so the backup words restore it.
export function seatSecret(hostSecretBytes) {
  const seed = new Uint8Array(15 + hostSecretBytes.length);
  seed.set(enc.encode('fkn-seat-key-1|'), 0); seed.set(hostSecretBytes, 15);
  return bls.utils.randomSecretKey(sha512(seed).slice(0, 48));   // the library wants exactly 48 seed bytes
}

export const seatPublic = (secret) => sig.getPublicKey(secret).toHex();

// Member side: blind my handle. Keep r private until the grant comes back.
export function blindSeat(era, handle) {
  let r = 0n;
  while (r === 0n) r = Fr.create(toBig(crypto.getRandomValues(new Uint8Array(48))));
  return { blinded: sig.Signature.toHex(sig.hash(seatMessage(era, handle)).multiply(r)), r: r.toString(16) };
}

// Host side: sign a blinded point. The host learns nothing about the handle.
export const signBlinded = (blindedHex, secret) => sig.Signature.toHex(sig.sign(g1(blindedHex), secret));

// Member side: remove the blinding. The result is the seat certificate.
export const unblindSeat = (signedHex, rHex) => sig.Signature.toHex(g1(signedHex).multiply(Fr.inv(BigInt('0x' + rHex))));

// Host's own seat, signed directly.
export const signSeat = (era, handle, secret) => sig.Signature.toHex(sig.sign(sig.hash(seatMessage(era, handle)), secret));

// Anyone: is this certificate a valid seat for this handle in this network?
export function verifySeat(certHex, era, handle, seatPublicHex) {
  try {
    const pub = bls.G2.Point.fromHex(seatPublicHex);
    pub.assertValidity();
    return sig.verify(g1(certHex), sig.hash(seatMessage(era, handle)), pub);
  } catch (e) { return false; }
}
