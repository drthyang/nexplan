"""Reference neutron structure factors from gemmi for the COD fixture CIFs.

gemmi's small-structure calculator expects crystallographic occupancies
(CIF occupancy divided by the site-symmetry order), so
change_occupancies_to_crystallographic() is called first; without it, atoms on
special positions are over-counted (NaCl F(200) comes out 48x too large).
gemmi's Neutron92 b values equal the Sears (1992) natural-element values used by
ScatterPlan for every element in these fixtures (checked in the test).

Run:  uv run --no-project --with gemmi==0.7.3 python scripts/data/gen_reference_sf.py
"""
import json
import math
import pathlib

import gemmi

ROOT = pathlib.Path(__file__).resolve().parents[2]
assert gemmi.__version__ == "0.7.3"
D_MIN = 0.8
FIXTURES = ["cod-1000041", "cod-1011097-exact", "cod-9001364", "cod-1010129", "cod-2104737"]

out = {"description": f"gemmi {gemmi.__version__} neutron F (fm) for all signed hkl with d >= {D_MIN} A", "dMin": D_MIN, "structures": []}
for name in FIXTURES:
    st = gemmi.read_small_structure(str(ROOT / f"fixtures/cif/{name}.cif"))
    st.change_occupancies_to_crystallographic()
    calc = gemmi.StructureFactorCalculatorN(st.cell)
    lim = [int(math.floor(x / D_MIN + 1e-9)) for x in (st.cell.a, st.cell.b, st.cell.c)]
    rows = []
    for h in range(-lim[0], lim[0] + 1):
        for k in range(-lim[1], lim[1] + 1):
            for l in range(-lim[2], lim[2] + 1):
                if h == k == l == 0:
                    continue
                d = st.cell.calculate_d([h, k, l])
                if d < D_MIN:
                    continue
                f = calc.calculate_sf_from_small_structure(st, [h, k, l])
                rows.append([h, k, l, round(d, 10), f.real, f.imag])
    out["structures"].append({"file": f"{name}.cif", "spacegroup": st.spacegroup.xhm() if st.spacegroup else st.spacegroup_hm, "rows": rows})
    print(name, st.spacegroup.xhm() if st.spacegroup else None, len(rows))
(ROOT / "fixtures/sf-gemmi-neutron.json").write_text(json.dumps(out) + "\n")
