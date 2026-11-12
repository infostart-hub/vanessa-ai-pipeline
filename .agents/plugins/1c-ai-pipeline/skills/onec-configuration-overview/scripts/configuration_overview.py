"""Read one 1C Configuration.xml; never infer runtime validity or permissions."""

import argparse
import hashlib
import json
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

MD = "http://v8.1c.ru/8.3/MDClasses"
V8 = "http://v8.1c.ru/8.1/data/core"
# Properties that bound which platform API and behaviour a change may rely on.
PLATFORM = {
    "vendor": "Vendor",
    "compatibility_mode": "CompatibilityMode",
    "extension_compatibility_mode": "ConfigurationExtensionCompatibilityMode",
    "script_variant": "ScriptVariant",
    "default_run_mode": "DefaultRunMode",
    "data_lock_control_mode": "DataLockControlMode",
    "interface_compatibility_mode": "InterfaceCompatibilityMode",
}


def inspect_configuration(path):
    path = Path(path).resolve(strict=True)
    raw = path.read_bytes()
    # Reject DTD/entity declarations, including UTF-16 encoded declarations.
    declaration_scan = raw.replace(b"\x00", b"").upper()
    if b"<!DOCTYPE" in declaration_scan or b"<!ENTITY" in declaration_scan:
        raise ValueError("DTD and entity declarations are not supported")
    root = ET.fromstring(raw)
    if root.tag == "{http://g5.1c.ru/v8/dt/metadata/mdclass}Configuration":
        raise ValueError("EDT .mdo requires native edt-mcp; this CLI reads XML dumps")
    if root.tag != f"{{{MD}}}MetaDataObject":
        raise ValueError("Expected 1C MetaDataObject root")
    configs = root.findall(f"{{{MD}}}Configuration")
    if len(configs) != 1:
        raise ValueError("Expected exactly one Configuration")
    config = configs[0]
    props = config.find(f"{{{MD}}}Properties")
    children = config.find(f"{{{MD}}}ChildObjects")
    if props is None or children is None:
        raise ValueError("Properties and ChildObjects are required")
    name = props.findtext(f"{{{MD}}}Name")
    if not name or not name.strip():
        raise ValueError("Configuration Name is required")
    properties = {}
    for item in props:
        if not item.tag.startswith(f"{{{MD}}}"):
            raise ValueError("Unexpected property namespace")
        key = item.tag.split("}", 1)[1]
        if key in properties:
            raise ValueError("Duplicate property: " + key)
        properties[key] = ET.tostring(item, encoding="unicode")
    synonyms = []
    for item in props.findall(f"{{{MD}}}Synonym/{{{V8}}}item"):
        synonyms.append(
            {
                "language": item.findtext(f"{{{V8}}}lang"),
                "text": item.findtext(f"{{{V8}}}content"),
            }
        )
    objects, counts = [], {}
    for item in children:
        if not item.tag.startswith(f"{{{MD}}}") or not (item.text or "").strip():
            raise ValueError("Invalid ChildObjects entry")
        kind = item.tag.split("}", 1)[1]
        objects.append({"type": kind, "name": item.text.strip()})
        counts[kind] = counts.get(kind, 0) + 1
    return {
        "schema": "onec-configuration-overview.v1",
        "source": {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest()},
        "name": name.strip(),
        "version": props.findtext(f"{{{MD}}}Version"),
        "synonyms": synonyms,
        "platform": {
            fact: (props.findtext(f"{{{MD}}}{tag}") or "").strip() or None
            for fact, tag in PLATFORM.items()
        },
        "properties_xml": properties,
        "objects": objects,
        "counts": counts,
        "total_objects": len(objects),
        "scope": "Configuration.xml only; no platform validation",
    }


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("configuration", type=Path)
    args = parser.parse_args()
    try:
        result = inspect_configuration(args.configuration)
    except (OSError, ValueError, ET.ParseError) as error:
        print(json.dumps({"status": "failed", "error": str(error)}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
