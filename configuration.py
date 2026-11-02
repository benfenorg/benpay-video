"""Read local node credentials without exposing them to workflows."""

import json
import os
import stat
import tempfile
import threading
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"
MAX_CONFIG_BYTES = 1024 * 1024
MAX_KEY_BYTES = 4096
CONFIG_LOCK = threading.Lock()


class ConfigurationError(ValueError):
    """The on-disk configuration cannot be used for a video request."""

    def __init__(self, message: str, code: str = "configurationError") -> None:
        super().__init__(message)
        self.code = code


def _read_configuration(config_path: Path, allow_missing: bool = False) -> dict:
    try:
        info = config_path.lstat()
        if not stat.S_ISREG(info.st_mode):
            raise ConfigurationError(
                "config.json must be a regular file, not a link.", "configFileType"
            )
        with config_path.open("rb") as config_file:
            raw = config_file.read(MAX_CONFIG_BYTES + 1)
    except FileNotFoundError as exc:
        if allow_missing:
            return {}
        raise ConfigurationError(
            "BenPay is not configured. Click Configure API Key or run comfyui-setup.",
            "configMissing",
        ) from exc
    except OSError as exc:
        raise ConfigurationError(
            "Cannot read config.json. Check file permissions.", "configRead"
        ) from exc
    if len(raw) > MAX_CONFIG_BYTES:
        raise ConfigurationError(
            "config.json exceeds the size limit.", "configTooLarge"
        )
    try:
        config = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise ConfigurationError(
            "config.json is invalid. Repair the file before saving.", "configInvalid"
        ) from exc
    if not isinstance(config, dict):
        raise ConfigurationError(
            "config.json must contain a JSON object.", "configObject"
        )
    version = config.get("schemaVersion", 1 if allow_missing else None)
    if type(version) is not int or version != 1:
        raise ConfigurationError(
            "This config.json version is unsupported. Update the node or repair the configuration.",
            "configVersion",
        )
    if "apiKey" in config and not isinstance(config["apiKey"], str):
        raise ConfigurationError("The apiKey field must be a string.", "configKeyType")
    return config


def _validate_api_key(api_key: object) -> str:
    if not isinstance(api_key, str) or not api_key.strip():
        raise ConfigurationError(
            "BenPay API Key is not configured. Click Configure API Key.", "keyMissing"
        )
    try:
        size = len(api_key.encode("utf-8"))
    except UnicodeError:
        raise ConfigurationError(
            "The API Key format is invalid.", "keyInvalid"
        ) from None
    if size > MAX_KEY_BYTES:
        raise ConfigurationError("The API Key exceeds the length limit.", "keyTooLarge")
    if any(character in api_key for character in ("\r", "\n", "\x00")):
        raise ConfigurationError("The API Key format is invalid.", "keyInvalid")
    return api_key.strip()


def read_api_key(config_path: Path | None = None) -> str:
    """Load the key for each task so configuration changes take effect immediately."""
    config = _read_configuration(config_path or CONFIG_PATH)
    return _validate_api_key(config.get("apiKey"))


def save_api_key(api_key: object, config_path: Path | None = None) -> None:
    """Save only local configuration, never a workflow or CLI credential bundle."""
    key = _validate_api_key(api_key)
    path = config_path or CONFIG_PATH
    with CONFIG_LOCK:
        config = _read_configuration(path, allow_missing=True)
        config.update(schemaVersion=1, apiKey=key)
        payload = (json.dumps(config, indent=2) + "\n").encode("utf-8")
        if len(payload) > MAX_CONFIG_BYTES:
            raise ConfigurationError(
                "config.json exceeds the size limit.", "configTooLarge"
            )
        _replace_configuration(path, payload)


def _replace_configuration(path: Path, payload: bytes) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=".config.json.tmp-", dir=path.parent, delete=False
        ) as config_file:
            temporary = Path(config_file.name)
            config_file.write(payload)
            config_file.flush()
            os.fsync(config_file.fileno())
        os.replace(temporary, path)
    except OSError:
        raise ConfigurationError(
            "Cannot save config.json. Check node directory permissions and retry.",
            "configSave",
        ) from None
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def configuration_status() -> dict[str, object]:
    """Return only non-sensitive configuration information for the UI."""
    try:
        api_key = read_api_key()
    except ConfigurationError:
        return {"configured": False, "suffix": ""}
    # Never reveal an entire short key, even through a supposedly masked value.
    return {"configured": True, "suffix": api_key[-4:] if len(api_key) > 8 else ""}
