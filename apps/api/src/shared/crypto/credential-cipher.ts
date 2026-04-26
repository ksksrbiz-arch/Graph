// AES-256-GCM credential encryption — implements ADR-006.
//
// Each user has a Data Encryption Key (DEK) wrapped by a Key Encryption Key
// (KEK) loaded from env. Connector tokens are encrypted with the DEK before
// being persisted in the `connector_configs` table.
//
// Phase 0 ships only the symmetric-encryption primitive — full DEK rotation
// & KMS integration arrives with Phase 1 (auth/users module).

import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedCredentials } from '@pkg/shared';
import { loadEnv } from '../../config/env';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

@Injectable()
export class CredentialCipher {
  private readonly kek: Buffer;
  private readonly keyId = 'kek-v1';

  constructor() {
    const { KEK_BASE64 } = loadEnv();
    this.kek = Buffer.from(KEK_BASE64, 'base64');
  }

  encrypt(plaintext: string): EncryptedCredentials {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.kek, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([enc, tag]).toString('base64'),
      iv: iv.toString('base64'),
      keyId: this.keyId,
    };
  }

  decrypt(creds: EncryptedCredentials): string {
    if (creds.keyId !== this.keyId) {
      throw new Error(`unsupported keyId: ${creds.keyId}`);
    }
    const iv = Buffer.from(creds.iv, 'base64');
    const blob = Buffer.from(creds.ciphertext, 'base64');
    const tag = blob.subarray(blob.length - TAG_BYTES);
    const data = blob.subarray(0, blob.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGO, this.kek, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  }
}
