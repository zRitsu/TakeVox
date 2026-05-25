from __future__ import annotations

import ipaddress
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def _write_private_key(path: Path, private_key: rsa.RSAPrivateKey) -> None:
    path.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )


def _write_certificate(path: Path, certificate: x509.Certificate) -> None:
    path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))


def ensure_local_certificates(cert_dir: Path, local_ip: str) -> dict[str, Path]:
    cert_dir.mkdir(parents=True, exist_ok=True)

    ca_cert_path = cert_dir / "takevox-root-ca.pem"
    ca_key_path = cert_dir / "takevox-root-ca-key.pem"
    server_cert_path = cert_dir / "takevox-server-cert.pem"
    server_key_path = cert_dir / "takevox-server-key.pem"

    if all(path.exists() for path in (ca_cert_path, ca_key_path, server_cert_path, server_key_path)):
        return {
            "ca_cert": ca_cert_path,
            "ca_key": ca_key_path,
            "server_cert": server_cert_path,
            "server_key": server_key_path,
        }

    now = datetime.now(timezone.utc)

    ca_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "BR"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "TakeVox Local CA"),
            x509.NameAttribute(NameOID.COMMON_NAME, "TakeVox Local Root CA"),
        ]
    )
    ca_certificate = (
        x509.CertificateBuilder()
        .subject_name(ca_subject)
        .issuer_name(ca_subject)
        .public_key(ca_private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_private_key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_private_key.public_key()), critical=False)
        .sign(private_key=ca_private_key, algorithm=hashes.SHA256())
    )

    server_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    server_subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "BR"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "TakeVox"),
            x509.NameAttribute(NameOID.COMMON_NAME, "TakeVox Local HTTPS"),
        ]
    )
    san_entries = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        x509.IPAddress(ipaddress.ip_address(local_ip)),
    ]
    server_certificate = (
        x509.CertificateBuilder()
        .subject_name(server_subject)
        .issuer_name(ca_certificate.subject)
        .public_key(server_private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=True, key_cert_sign=False, key_agreement=False, content_commitment=False, data_encipherment=False, encipher_only=False, decipher_only=False, crl_sign=False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(server_private_key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_private_key.public_key()), critical=False)
        .sign(private_key=ca_private_key, algorithm=hashes.SHA256())
    )

    _write_private_key(ca_key_path, ca_private_key)
    _write_certificate(ca_cert_path, ca_certificate)
    _write_private_key(server_key_path, server_private_key)
    _write_certificate(server_cert_path, server_certificate)

    return {
        "ca_cert": ca_cert_path,
        "ca_key": ca_key_path,
        "server_cert": server_cert_path,
        "server_key": server_key_path,
    }
