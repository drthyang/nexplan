"""Generate src/data/space-groups.json and fixtures/absences-gemmi.json from gemmi.

Every setting in gemmi's table (564 at gemmi 0.7.3): origin choices 1/2,
rhombohedral :H/:R, monoclinic cell choices and unique axes. Each entry lists
the full general-position operation list including centring translations, as
Jones-Faithful triplets. The absences fixture records gemmi's
is_systematically_absent for all |h|,|k|,|l| <= 4 per setting, so the app's
op-based absence test can be checked against an independent implementation.

Run:  uv run --no-project --with gemmi==0.7.3 python scripts/data/gen_space_groups.py
"""
import base64
import hashlib
import json
import pathlib

import gemmi

ROOT = pathlib.Path(__file__).resolve().parents[2]
GEMMI_VERSION = "0.7.3"
assert gemmi.__version__ == GEMMI_VERSION, f"pin gemmi=={GEMMI_VERSION}, got {gemmi.__version__}"

R = 4
HKL = [(h, k, l) for h in range(-R, R + 1) for k in range(-R, R + 1) for l in range(-R, R + 1)]

entries = []
absences = []
for sg in gemmi.spacegroup_table():
    ops = sg.operations()
    triplets = [op.triplet() for op in ops]  # all ops incl. centring
    entries.append({
        "number": sg.number,
        "hm": sg.hm,
        "short": sg.short_name(),
        "ext": sg.ext,
        "xhm": sg.xhm(),
        "hall": sg.hall.strip(),
        "qualifier": sg.qualifier,
        "ccp4": sg.ccp4,
        "isReference": sg.is_reference_setting(),
        "ops": triplets,
    })
    bits = bytearray((len(HKL) + 7) // 8)
    for i, hkl in enumerate(HKL):
        if ops.is_systematically_absent(list(hkl)):
            bits[i // 8] |= 1 << (i % 8)
    absences.append({"xhm": sg.xhm(), "absent": base64.b64encode(bytes(bits)).decode()})

table = {
    "dataset": "space-groups-gemmi",
    "version": "0.1.0",
    "generator": f"scripts/data/gen_space_groups.py with gemmi {GEMMI_VERSION}",
    "citation": "Wojdyr, M. (2022). GEMMI: A library for structural biology. JOSS 7(73), 4200. Settings follow ITA and Hall (1981); Grosse-Kunstleve (1999).",
    "settings": entries,
}
out = json.dumps(table, indent=1, ensure_ascii=False) + "\n"
(ROOT / "src/data/space-groups.json").write_text(out)
fx = {
    "description": f"gemmi {GEMMI_VERSION} is_systematically_absent for h,k,l in [-{R},{R}], h slowest; bit i of the little-endian bitstring is HKL[i].",
    "range": R,
    "settings": absences,
}
(ROOT / "fixtures/absences-gemmi.json").write_text(json.dumps(fx, indent=1) + "\n")
print(len(entries), "settings; sha256", hashlib.sha256(out.encode()).hexdigest()[:16])
