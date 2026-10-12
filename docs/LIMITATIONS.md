# Limitations

NEXPLAN computes geometry and relative Bragg intensities only: |F|² with Lorentz (and, for X-rays, polarization)
factors. It is a personal toolkit, not an ORNL or SNS facility tool.

- Not modelled: counting time, absolute intensity, detector efficiency, background, diffuse scattering, magnetic
  scattering, anomalous X-ray scattering, gaps between the tubes of a pack, and inelastic scattering (chopper
  spectrometers are simulated at the elastic line).
- Not applied to intensities: absorption, extinction, multiple scattering, preferred orientation. (The scattering
  power card estimates an attenuation length.)
- Detector positions are nominal: the Mantid instrument definition at a pinned commit, not a cycle's calibration.
  NOMAD banks are numbered 0–5, as in Mantid and the TOPAS files (GSAS files: 1–6); banks 0–4 use calibrated DIFC.
- Masks and shadows apply only as you set them; there are no defaults.
- Anisotropic ADPs enter as U_eq. Complex b are the 2200 m/s values.
- CIF 1.1 only. Ambiguous settings (origin choice, rhombohedral axes, monoclinic cell choice) are asked, not guessed.
- The scattering tables are cross-checked against independent copies but not yet against the printed sources
  ([VALIDATION](VALIDATION.md)). Check anything you publish.

Each instrument's own limits, as the agent tools report them (`instrument_limits`), are listed in
[MCP](MCP.md#instrument-limits).
