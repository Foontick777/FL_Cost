"""Generate a proper Fernet key for ENCRYPTION_KEY.

Usage:
    python -m app.scripts.generate_fernet_key

Prints a fresh, cryptographically-random 32-byte Fernet key (44-char
urlsafe-base64 string). Copy it into your .env file:

    ENCRYPTION_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

CRITICAL: do not store this key alongside your DB backups — anyone with
both the backup AND the key can decrypt every e100 password you've stored.
Treat it like a password manager vault key: keep it in your secrets
manager (Vault, AWS Secrets Manager, etc.) or in a separate file with
restricted permissions, never in the same repository as the code or
backed up to the same volume as the database.
"""
from cryptography.fernet import Fernet


def main() -> None:
    key = Fernet.generate_key().decode()
    print("=" * 72)
    print("Generated a fresh Fernet key. Copy this into your .env file:")
    print("=" * 72)
    print(f"ENCRYPTION_KEY={key}")
    print("=" * 72)
    print()
    print("REMINDER:")
    print("  • Do NOT commit this key to git.")
    print("  • Do NOT store it next to DB backups.")
    print("  • If you are rotating an OLD key, you must also re-enter all")
    print("    e100 credentials (the old encrypted_password values cannot")
    print("    be decrypted with the new key — there is no automatic")
    print("    migration path because the old key was never stored).")
    print()


if __name__ == "__main__":
    main()
