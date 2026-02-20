import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import forge from 'node-forge';

type CaMaterial = {
  keyPem: string;
  certPem: string;
  certDer: Buffer;
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function readTextIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeTextFile(p: string, content: string, mode?: number) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, { encoding: 'utf8', mode });
}

function writeBinaryFile(p: string, content: Buffer, mode?: number) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, { mode });
}

function safeHostFilename(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return 'unknown';
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200);
}

function randomSerialHex(bytes = 16): string {
  // Serial number must be unique; 128 bits is plenty.
  return randomBytes(bytes).toString('hex');
}

function toDer(cert: forge.pki.Certificate): Buffer {
  const asn1 = forge.pki.certificateToAsn1(cert);
  const derBytes = forge.asn1.toDer(asn1).getBytes();
  return Buffer.from(derBytes, 'binary');
}

function generateCa(): CaMaterial {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialHex();

  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - 1);
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 10);

  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: 'commonName', value: 'CipherScope Local CA' },
    { name: 'organizationName', value: 'CipherScope' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  const certDer = toDer(cert);

  return { keyPem, certPem, certDer };
}

function generateHostCert(input: {
  host: string;
  caKey: forge.pki.rsa.PrivateKey;
  caCert: forge.pki.Certificate;
}): { keyPem: string; certPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialHex();

  const notBefore = new Date();
  notBefore.setDate(notBefore.getDate() - 1);
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 2);

  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  cert.setSubject([{ name: 'commonName', value: input.host }]);
  cert.setIssuer(input.caCert.subject.attributes);

  const isIp = net.isIP(input.host) !== 0;
  const altNames = isIp
    ? [{ type: 7, ip: input.host }]
    : [{ type: 2, value: input.host }];

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(input.caKey, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

export class CertStore {
  #dir: string;
  #hostsDir: string;
  #caKeyPath: string;
  #caCertPath: string;
  #caCertDerPath: string;
  #caMaterial: CaMaterial | null = null;
  #caKeyObj: forge.pki.rsa.PrivateKey | null = null;
  #caCertObj: forge.pki.Certificate | null = null;
  #hostCache = new Map<string, { keyPem: string; certPem: string }>();

  constructor(opts: { dir: string }) {
    this.#dir = path.resolve(opts.dir);
    this.#hostsDir = path.join(this.#dir, 'hosts');
    this.#caKeyPath = path.join(this.#dir, 'ca.key.pem');
    this.#caCertPath = path.join(this.#dir, 'ca.cert.pem');
    this.#caCertDerPath = path.join(this.#dir, 'ca.cert.der');
  }

  getCaPaths(): { caKeyPath: string; caCertPath: string; caCertDerPath: string } {
    return {
      caKeyPath: this.#caKeyPath,
      caCertPath: this.#caCertPath,
      caCertDerPath: this.#caCertDerPath,
    };
  }

  ensureCa(): { keyPem: string; certPem: string } {
    if (this.#caMaterial) return { keyPem: this.#caMaterial.keyPem, certPem: this.#caMaterial.certPem };

    const keyPem = readTextIfExists(this.#caKeyPath);
    const certPem = readTextIfExists(this.#caCertPath);
    if (keyPem && certPem) {
      const certDer = (() => {
        try {
          return fs.readFileSync(this.#caCertDerPath);
        } catch {
          const parsed = forge.pki.certificateFromPem(certPem);
          const out = toDer(parsed);
          writeBinaryFile(this.#caCertDerPath, out);
          return out;
        }
      })();
      this.#caMaterial = { keyPem, certPem, certDer };
      this.#caKeyObj = forge.pki.privateKeyFromPem(keyPem) as unknown as forge.pki.rsa.PrivateKey;
      this.#caCertObj = forge.pki.certificateFromPem(certPem);
      return { keyPem, certPem };
    }

    ensureDir(this.#dir);
    const generated = generateCa();
    writeTextFile(this.#caKeyPath, generated.keyPem, 0o600);
    writeTextFile(this.#caCertPath, generated.certPem, 0o644);
    writeBinaryFile(this.#caCertDerPath, generated.certDer, 0o644);

    this.#caMaterial = generated;
    this.#caKeyObj = forge.pki.privateKeyFromPem(generated.keyPem) as unknown as forge.pki.rsa.PrivateKey;
    this.#caCertObj = forge.pki.certificateFromPem(generated.certPem);
    return { keyPem: generated.keyPem, certPem: generated.certPem };
  }

  getCaCertPem(): string {
    return this.ensureCa().certPem;
  }

  getCaCertDer(): Buffer {
    this.ensureCa();
    if (!this.#caMaterial) throw new Error('CA material missing after ensureCa');
    return this.#caMaterial.certDer;
  }

  getOrCreateHostCert(host: string): { keyPem: string; certPem: string } {
    const normalized = host.trim().toLowerCase();
    if (!normalized) throw new Error('Host is empty');
    const cached = this.#hostCache.get(normalized);
    if (cached) return cached;

    this.ensureCa();
    if (!this.#caKeyObj || !this.#caCertObj) {
      throw new Error('CA key/cert objects missing');
    }

    const safe = safeHostFilename(normalized);
    const keyPath = path.join(this.#hostsDir, `${safe}.key.pem`);
    const certPath = path.join(this.#hostsDir, `${safe}.cert.pem`);

    const keyPem = readTextIfExists(keyPath);
    const certPem = readTextIfExists(certPath);
    if (keyPem && certPem) {
      const out = { keyPem, certPem };
      this.#hostCache.set(normalized, out);
      return out;
    }

    ensureDir(this.#hostsDir);
    const generated = generateHostCert({
      host: normalized,
      caKey: this.#caKeyObj,
      caCert: this.#caCertObj,
    });
    writeTextFile(keyPath, generated.keyPem, 0o600);
    writeTextFile(certPath, generated.certPem, 0o644);

    this.#hostCache.set(normalized, generated);
    return generated;
  }
}
