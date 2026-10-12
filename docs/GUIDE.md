# User guide

NEXPLAN is my personal toolkit for planning neutron experiments at the SNS. I wrote it for my own beamtimes; it is
public in case it helps others. It runs in the browser at **https://drthyang.github.io/nexplan/**, with nothing to
install, and files are not uploaded.

## Quick start

1. Load a CIF (or a demo structure). **Structure** and **Reflections** show what was read and every reflection
   with its structure factor.
2. Choose an instrument in the header, or a generic X-ray or neutron beam.
3. Single crystal: load a UB on **Orientation** (or keep the CIF cell with U = I). On **Single crystal**, type the
   reflections you need and press *Suggest settings* (TOPAZ), or set a rotation scan (CORELLI, ψ scans).
4. Powder: **Powder** shows the pattern of each focused bank; **Detectors** shows the rings on the panels.

The session is kept in the browser's storage, so a reload resumes it.

## What it computes

| Instrument | What it computes |
|---|---|
| TOPAZ | Bragg spots on the panels at a goniometer setting. Finds a setting that centres a chosen reflection, or a set of settings that records the chosen reflections (greedy, with proven bounds: a starting plan, not an optimum). |
| CORELLI | Rotation or rocking scans, and completeness as the scan proceeds. |
| NOMAD, POWGEN | Bragg powder pattern of a focused bank (focused and divided by vanadium) or of a single panel, on TOF, d or Q, with measured peak widths (NOMAD: Δd/d per bank, 2014; POWGEN: ORNL's GSAS-II profiles). Warns when d_min cuts the bank's range; says whether two lines are resolved. |
| ARCS, SEQUOIA, CNCS | Elastic line only: powder rings and single-crystal ψ scans at a chosen Ei. The chopper setting sets the elastic width. |
| Generic beam | Reflection lists and powder patterns for X-rays or neutrons at one wavelength, or at one TOF bank. |

Also:

- Reflections with d, Q and complex F, folded into symmetry families, with absences flagged. Absent or weak
  reflections can still be simulated and planned.
- The mount: choose the scattering plane, (H K 0), (H H L) or any u and v, and without a UB file the crystal is
  oriented as Mantid's SetUB would (u along the beam, v horizontal); the Detectors page shows the plane at the sample,
  its tilt and the curve on the detectors where its reflections land.
- UB matrices in the ISAW format, read and written. A UB for a supercell or a smaller cell of the CIF cell (e.g.
  2 × 2 × 2) is recognised and written in the CIF cell; any UB can be re-indexed to another cell.
- Every detector pixel a reflection can reach over the goniometer range.
- The recorded HKL range along chosen axes, as Mantid MDNorm parameters (Mantid's default Q convention or the
  crystallographic one), with practical bins: a round step giving about 200–400 bins per axis, or one you choose, and
  energy steps of 1 % of Ei for chopper spectrometers (Mantid's default). The best bin depends on your counts: try a
  few.
- Detector masks (including Mantid mask files) and sample-environment shadows, used in every hit test.
- Scattering power relative to a reference material (V, diamond, Si, CeO₂, corundum).

The same calculations are available to AI agents as MCP tools: [MCP](MCP.md). What is not modelled is in
[LIMITATIONS](LIMITATIONS.md).

## Related tools

The facility tools cover measured data and much that NEXPLAN does not:

- [NeuXtalViz](https://github.com/neutrons/NeuXtalViz-tools): single-crystal UB, reduction, slicing and experiment
  planning (TOPAZ, CORELLI, MANDI and others).
- [Mantid](https://www.mantidproject.org/): DGS Planner for inelastic Q–E coverage on chopper spectrometers; PyChop
  for their resolution and flux; PredictPeaks and InstrumentView.
- [ADDIE](https://github.com/neutrons/addie): total-scattering reduction for NOMAD, S(Q) and G(r).
