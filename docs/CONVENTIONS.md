# Scientific conventions

Frozen for ScatterPlan 0.1. Changing anything here is a breaking change and needs a changelog entry and the full
regression suite. Each item names the code that implements it and the test that holds it.

## 1. Units

- Lengths are in Å and reciprocal lengths in Å⁻¹. Angles are entered and displayed in degrees and computed in
  radians.
- X-ray amplitudes are in electrons and neutron amplitudes in fm, so |F|² is in e² or fm² per conventional cell. The
  two are never put on a common absolute scale.

## 2. Lattice

- The direct basis A has the lattice vectors a, b, c as columns, and r = A·x for fractional coordinates x.
- The metric is G = AᵀA. G is computed in MATERIA's `metricTensor`; ScatterPlan uses its copy in `src/materia/`.
- The reciprocal basis is C = A⁻ᵀ, without 2π. Then g = C·h, 1/d² = hᵀG⁻¹h and Q = 2π/d.
- s = sinθ/λ = 1/(2d). The scattering tables use this variable.
- Basis change, with ITA's convention (a′, b′, c′) = (a, b, c)·P, i.e. A_new = A_old·P:
  - x_new = P⁻¹(x_old − p)
  - h_new = Pᵀh_old
  - UB_new = UB_old·P⁻ᵀ
  - G_new = PᵀG_old·P

## 3. Symmetry

- An operation is x′ = R·x + t, with R an integer matrix and t in multiples of 1/24.
- Parsing is exact. Text is never evaluated as code, and translations that are not multiples of 1/24 are rejected
  (`src/core/symmetry/ops.ts`).
- Reflection h is systematically absent iff some operation (R, t) of the full group, including centring, has
  hᵀR = hᵀ and h·t ∉ ℤ. This is integer arithmetic.
  - Test: equality with gemmi `is_systematically_absent` for every one of the 564 settings, |h|, |k|, |l| ≤ 4.
- The setting is never guessed. An H-M symbol shared by several settings (origin choice 1/2, rhombohedral vs.
  hexagonal axes without a decisive cell, monoclinic cell choices) needs explicit operations, a Hall symbol, or the
  user's choice. A Hall symbol that contradicts the H-M symbol is an error (`src/core/symmetry/spaceGroups.ts`).

## 4. Structure factor

F(h) = Σⱼ oⱼ · aⱼ(s) · exp(−Bⱼ s²) · exp(+2πi h·xⱼ)

- The sum runs over the expanded cell. o is the occupancy, and B = 8π²U_iso.
- The phase sign is that of ITC Vol. B.
- Symmetry images closer than 0.02 Å are one position. Each cluster of coincident images is replaced by its centroid,
  so a site given on a rounded special position (0.3333 for 1/3) still expands to an exactly symmetric arrangement.
- Images 0.02–0.5 Å apart are kept and reported.
- Test: complex F equal to gemmi 0.7.3 within 1e-8·Σ|o·a·T| for five COD structures, phases included.

## 5. Scattering amplitudes and the sign of complex b

- **X-rays:** a = f0(s) from Waasmaier & Kirfel (1995), for 0 ≤ s ≤ 6 Å⁻¹. Outside that range the evaluator
  throws. There are no anomalous terms yet.
- **Neutrons:** Sears (1992) prints the bound coherent length as b = b′ − i b″ with b″ ≥ 0 for absorbing nuclei.
  That is the physics convention:
  - time dependence exp(−iωt);
  - Q = k_out − k_in;
  - scattered amplitude ∝ Σ (−b) exp(−iQ·r);
  - Im(−b) > 0 by the optical theorem.
- **Why the conjugate.** The crystallographic convention, F = Σ f exp(+2πi h·x) with X-ray f″ > 0, is the complex
  conjugate of that amplitude. So the neutron term in F is **a = conj(b) = b′ + i b″**.
- **Where it lives.** The tables store b exactly as printed; `amplitudeFor` conjugates.
- **Tests:**
  - |F(h)|² from the code equals the physics-convention |Σ b exp(−2πi h·x)|² for a non-centrosymmetric Gd
    structure.
  - Using the printed b directly gives I(−h) instead.
  - Every absorbing nucleus gets a positive imaginary amplitude, the same sign as X-ray f″.
- **Consequences.** Powder intensities and centrosymmetric structures are unaffected by the sign. For
  non-centrosymmetric single crystals, the wrong sign reverses Bijvoet differences.

## 6. Reflections

- The full signed list is enumerated with |hᵢ| ≤ ⌊|aᵢ|/d_min⌋ per axis. This bound is exact, because hᵢ = aᵢ·g and
  |g| ≤ 1/d_min. Reflections are then filtered by d ≥ d_min.
- Exceeding the reflection limit is an error. The list is never truncated.
- **Classes:**
  - *systematic*: from the operations;
  - *accidental*: |F| ≤ 1e-8·Σ|o·a·T| although symmetry allows the reflection;
  - *present*: everything else.
- Example: diamond Si (222) is accidental and (200) is systematic.
- Friedel pairs are kept separate whenever any amplitude is complex.

## 7. Powder (constant wavelength)

- **Intensity.** For each distinct d (|Δd| ≤ 1e-9·d), I = Σ|F|² over every signed hkl at that d. No multiplicity
  factor enters the intensity. Families (orbits under the point group, merged with Friedel mates when amplitudes are
  real) supply labels and multiplicities only.
- **Lorentz factor.** L = 1/(sin²θ cosθ), for Debye–Scherrer and Bragg–Brentano.
- **Polarization (X-rays only):**
  - unpolarized: (1 + cos²2θ)/2;
  - monochromator: (1 + cos²2θ_M cos²2θ)/(1 + cos²2θ_M);
  - linearly polarized, fraction f perpendicular to the scattering plane: f + (1 − f)cos²2θ.
  - Neutrons get no polarization factor.
- **Profiles.** Each peak is a unit-area pseudo-Voigt (MATERIA `pseudoVoigt`) times the integrated intensity. The
  pattern is synthesized natively on the chosen axis (2θ, d or Q) with the FWHM in that axis's units, so no Jacobian
  resampling is involved.
- **Not modelled:** absorption, texture, extinction, sample displacement and asymmetry.

## 7b. Powder (neutron time-of-flight, one detector bank)

- **Position** (GSAS-II `GSASIIlattice.py`): t = ZERO + DIFC·d + DIFA·d² in µs.
- **DIFC from geometry** (Mantid `Unit.cpp`): DIFC = (m_n/h)·L·2 sinθ. Here m_n/h = 252.778 413 µs/(m·Å)
  (CODATA 2018; agrees with Mantid's CODATA 2006 value to 8×10⁻⁹), L = L1 + L2 and 2θ is the bank angle.
  Calibrated DIFC/DIFA/ZERO from an instrument file override the geometry.
- **Wavelength band.** A bank sees d = λ/(2 sinθ) for λ in [λmin, λmax]. Each peak has its own λ = 2d sinθ.
- **Intensity** (GSAS-II `GSASIIstrMath.py`, "TOF Lorentz correction"): I = Σ|F|² · sinθ · d⁴. This is for data
  normalized by the incident spectrum; the spectrum and detector efficiency are not modelled.
- **Peak shapes.**
  - Constant relative resolution: a Gaussian with FWHM_t = (Δd/d)·t.
  - GSAS-II back-to-back exponentials ⊗ Gaussian (MATERIA `tofBackToBack`, unit area), with α = α₁/d,
    β = β₀ + β₁/d⁴ and σ² = σ₀ + σ₁d² + σ₂d⁴ (µs). There is no Lorentzian γ term yet.
- **Grid and axes.** The pattern is built on a logarithmic TOF grid (constant Δt/t). A d or Q axis transforms the
  density with its Jacobian (|dt/dd| = DIFC + 2·DIFA·d; |dt/dQ| = |dt/dd|·d²/2π), so peak areas are the same on
  every axis.
- **Resonant nuclei.** Complex b (Sears) is valid near 2200 m/s only. TOF spans many wavelengths, so resonant
  absorbers are flagged.

## 7c. Wavelength and energy

- X-rays: E = hc/λ, with hc = 12.398 419 843 keV·Å.
- Neutrons: E = h²/(2m_nλ²), with h²/2m_n = 81.8042 meV·Å².
- Both use CODATA 2018. λ is the stored quantity; energy is a view of it.

## 7d. X-ray form factors and ions

- Every site uses the neutral-atom Waasmaier–Kirfel f0 by default, whatever charge its CIF type symbol gives, as in
  GSAS-II and FullProf.
- A site switches to a tabulated ionic f0 only by an explicit per-site choice, which is recorded as an assumption.
  Free O²⁻ in particular is ill-defined; see `data-verification/XRAY_WK1995.md`.
- Neutron b never depends on the charge.

## 8. Orientation (for M3; recorded now so importers agree)

- UB maps a column hkl to g in the sample frame, without 2π. Sample rotations act on the left; basis changes act on
  the right. Q_lab = 2π·R·UB·h.
- **ISAW UB files** (Mantid `SaveIsawUB.cpp` at the pinned commit):
  - the file stores UBᵀ;
  - its frame is the IPNS frame: x is the beam, z is up, right-handed;
  - |Q′| = 1/d;
  - Mantid's frame relates to it by z_M = x_I, x_M = y_I, y_M = z_I.
