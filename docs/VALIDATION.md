# Validation

What NEXPLAN's numbers are checked against. The formulas, each with its literature source, are in
[CONVENTIONS](CONVENTIONS.md).

## Checks

Tables are generated from pinned upstream files ([`data-sources/sources.json`](../data-sources/sources.json)) and
tested (`npm test`):

- X-ray f0, Waasmaier & Kirfel (1995): 209 species cross-checked ([report](data-verification/XRAY_WK1995.md)).
- Neutron b, Sears (1992): 324 rows cross-checked, 6 discrepant rows listed
  ([report](data-verification/NEUTRON_SEARS1992.md)).
- Systematic absences equal gemmi's for all 564 space-group settings. Neutron F equals gemmi 0.7.3's to 1e-8,
  phases included.
- Constants, DIFC, TOF, E ↔ λ, the B matrix and goniometers follow Mantid
  ([report](data-verification/MANTID_CONSISTENCY.md)).
- The energy resolution is a port of Mantid PyChop's model (`67c2f43`; ARCS and SEQUOIA parameters tuned to ORNL
  vanadium data, Mantid PR #38591), tested to reproduce its output to 1e-6.
- POWGEN peak widths (0.8 Å frame) are within 25 % of the LaB₆ widths in Huq et al., J. Appl. Cryst. 52, 1189
  (2019).
- MATERIA's scattering tables are checked against independent transcriptions of the same publications
  ([report](data-verification/MATERIA_TABLES.md)), and the MATERIA modules copied into `src/materia/` are checked
  byte for byte against the pinned commit (`npm run materia:check`).

The scattering tables are cross-checked against independent copies but not yet against the printed sources.

## Review

A code review on 2026-10-06, not a domain-expert review, re-derived the formulas against the literature and the
pinned upstream code and corrected a few; the corrections are listed in
[CONVENTIONS §13](CONVENTIONS.md#13-changes-from-the-2026-10-06-audit).

## Key references

The full list is in [CONVENTIONS §12](CONVENTIONS.md#12-references); each formula there cites its source.

- Busing & Levy, *Acta Cryst.* 22, 457 (1967): UB matrix and goniometer angles.
- *International Tables for Crystallography* Vols. A, B and C: space groups, structure factors, Lorentz–polarization.
- Waasmaier & Kirfel, *Acta Cryst.* A51, 416 (1995); Sears, *Neutron News* 3(3), 26 (1992).
- Von Dreele, Jorgensen & Windsor, *J. Appl. Cryst.* 15, 581 (1982), and GSAS-II (Toby & Von Dreele, *J. Appl.
  Cryst.* 46, 544 (2013)): TOF positions, Lorentz factor and peak shapes.
- Mantid (Arnold et al., *Nucl. Instrum. Methods* A764, 156 (2014)) at `67c2f43`: instrument definitions, units,
  goniometers, ISAW files, PyChop.
- Nemhauser, Wolsey & Fisher, *Math. Program.* 14, 265 (1978); Johnson, *J. Comput. Syst. Sci.* 9, 256 (1974): the
  planner's greedy bounds.
