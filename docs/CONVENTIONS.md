# Scientific conventions

Frozen for NEXPLAN 0.1. Changing anything here is a breaking change and needs a changelog entry and the full
regression suite. Each item names the code that implements it and the test that holds it.

## 1. Units

- Lengths are in Å and reciprocal lengths in Å⁻¹. Angles are entered and displayed in degrees and computed in
  radians.
- X-ray amplitudes are in electrons and neutron amplitudes in fm, so |F|² is in e² or fm² per conventional cell. The
  two are never put on a common absolute scale.

## 2. Lattice

- The direct basis A has the lattice vectors a, b, c as columns, and r = A·x for fractional coordinates x.
- The metric is G = AᵀA. G is computed in MATERIA's `metricTensor`; NEXPLAN uses its copy in `src/materia/`.
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

## 8. Orientation, goniometers and the Laue condition

- UB maps a column hkl to g in the sample frame, without 2π. Sample rotations act on the left; basis changes act on
  the right. Q_lab = 2π·R·UB·h.
- **ISAW UB files** (Mantid `SaveIsawUB.cpp` at the pinned commit):
  - the file stores UBᵀ;
  - its frame is the IPNS frame: x is the beam, z is up, right-handed;
  - |Q′| = 1/d;
  - Mantid's frame relates to it by z_M = x_I, x_M = y_I, y_M = z_I.
- **Q sign and Miller indices** (mantid @ 67c2f43):
  - Mantid's UB uses the inelastic convention, q = (k_i − k_f)/2π = UB·h (`OrientedLattice.cpp:88-91`), and the
    default `Q.convention` is Inelastic.
  - The indexer keeps det UB > 0 (`IndexingUtils.cpp:1846-1850`), so a convention change flips the hkl labels, not
    UB.
  - ISAW peaks I/O flips hkl accordingly (`LoadIsawPeaks.cpp:427-432`).
  - For crystallographic indices, which NEXPLAN uses, q_cryst = k_f − k_i = UB·h. Mantid's default labels the same
    reflection (−h −k −l).
  - Verified on Mantid's TOPAZ_3007 data: all 43 peaks index to +hkl. Predicted λ, 2θ and azimuth agree within
    0.73 %, 0.43° and 0.38° (`src/core/ub/topaz.test.ts`).
- **Goniometer.**
  - An axis is "name, x, y, z, sense", with sense +1 meaning counter-clockwise (right-hand rule).
  - R = R(axis0)·R(axis1)·…, with axis 0 outermost.
  - q_lab = R·UB·h.
  - Mantid "Universal" is ω about +y, χ about +z, φ about +y.
- **TOPAZ.**
  - Cryogenic goniometer: ω only.
  - Ambient goniometer: ω and φ, with χ fixed at 135°.
  - Wavelength band 0.4–3.5 Å; L1 = 18.035 m.
  - Sources are listed in `src/core/ub/instruments.ts`.
- **Laue condition** (white beam or TOF), with k_i = (1/λ)·ẑ and k_f = k_i + q:
  - λ = −2 q_z/|q|², which requires q_z < 0;
  - 2θ is the angle between k_f and ẑ;
  - the azimuth is measured from +x toward +y.
- **Basis change** (ITA): UB′ = UB·P⁻ᵀ and h′ = Pᵀh. A loaded UB in another setting is mapped onto the CIF setting
  by an integer P with entries in {−1, 0, 1} and det P = +1, such that Pᵀ·G_CIF·P ≈ G_UB within 2 %.
  - Because (a′, b′, c′) = (a, b, c)·P and h′ = Pᵀh, a new axis and its new index have the same coefficients
    (column j of P): a′ = a + b goes with h′ = h + k. The Re-index card edits P in that form, one row per new axis.
  - Mantid's TransformHKL takes M = Pᵀ, nine numbers row by row, applying h′ = M·h and UB′ = UB·M⁻¹ (= UB·P⁻ᵀ);
    it rejects det M ≤ 0 (docs.mantidproject.org, TransformHKL v1). Tested on the √2 × √2 × 1 cell.

## 9. Detector geometry

- **Panels** are read from Mantid instrument definition files (IDFs) with `scripts/data/idf.ts`:
  - `<location>` positions are relative to the parent, in the parent's rotated frame. Spherical (r, t, p) has t from
    +z toward +x and p the azimuth in the xy-plane.
  - Nested `<rot>` elements are applied outermost first, about the already-rotated axes, i.e.
    R = R_outer·R_next·…. A `<rot>` with no axis turns about z.
  - Rectangular detectors map exactly.
  - Tube packs (pack → tube → pixel) are fitted with a rectangle: rows along the tubes, columns across them. Every
    pack in the shipped data is flat to under 0.01 mm.
- **Pixels** follow the ISAW / Mantid peaks-file convention, col = (x/w + ½)·n_cols + ½, with x measured along
  `base` from the panel centre (rows likewise along `up`), so pixel centres sit at 1 … n.
- **Validation** on Mantid's TOPAZ_3007 (`src/core/instrument/detectors.test.ts`):
  - The reader applied to the IDF valid for that run reproduces the 13 panel geometries Mantid wrote into the peaks
    file: centres to 0.001 mm, axes to 1.5×10⁻⁴.
  - Every observed peak lands on its recorded detector within 0.1 pixel.
  - Peaks predicted from UB and the goniometer land on the right detector, within the UB fit's angular residual
    (≤ 5.4 pixels).
- **Instruments:** TOPAZ (2022-11-21), CORELLI, NOMAD (2022-05-05), POWGEN (2018-05-05), ARCS (2012-10-11),
  SEQUOIA (2019-04-04) and CNCS (2026-02-02) definitions at Mantid commit 67c2f43, generated into
  `src/data/instruments.json` and loaded with the Instrument page.

## 10. Instrument simulations

On the simulation pages (Detectors, Powder, Single crystal) for the SNS instrument chosen in the header (always
neutron scattering); code in
`src/core/instrument/simulate.ts` and `src/core/instrument/powderRings.ts`.

- **Detector map:** directions are unrolled onto a cylinder about the vertical axis, as in Mantid's instrument
  view: γ = atan2(u_x, u_z) (0 along the beam, +90° towards +x) and ν = asin(u_y). A cone of constant 2θ
  satisfies cos 2θ = cos γ · cos ν.
- **Single crystal:** at goniometer setting R, reflection h is on a detector when its Laue wavelength (§8) is in the
  band and the ray along k_f hits a panel (§9). A rotation scan steps one axis with the others fixed. Completeness is
  the fraction of symmetry families with at least one member seen so far, over the families among the simulated
  reflections (the strongest 6000 present with d ≥ d_min). Friedel mates are merged only when the amplitudes are
  real.
- **Reflection coverage** (single crystal; NeuXtalViz's "individual peak" coverage, models/experiment_planner.py
  @ 655afa3): every detector position where the chosen reflection can be recorded, optionally with its symmetry
  equivalents, as the free goniometer axes sweep their ranges.
  - Each point is coloured by its wavelength, λ = 2d sin θ at that pixel.
  - White-beam instruments use a grid of settings: 1° steps, doubled for each extra free axis, each axis at most one
    turn. A setting counts when λ = −2q_z/|q|² is in the band and k_f hits a panel.
  - Chopper spectrometers use the exact Bragg crossings instead.
  - Tested: every point satisfies λ = 2d sin θ at the pixel it hits, and lies in the band.
- **Exact coverage** (`src/core/instrument/coverage.ts`): per detector pixel, the pixel fixes q̂ ∝ u − ẑ and
  λ = 2d sin θ; with R = M₀·Rot(n₁, s₁a)·M₁·Rot(n₂, s₂b)·M₂ (fixed axes in the M's), the component of the rotated
  reflection along n₁ is a sinusoid in b, giving at most two b per turn, each with one a; both are checked against
  the axis ranges, within the pixel's angular half-size (q̂ turns half as fast as k_f). Tested by rotating forward to
  the returned angles, against the stepped sweep, and against the ω-only and χ = 135° analytic cases. It replaced the
  stepped sweep for display, which left gaps because the beam turns twice as fast as the crystal.
- **Measurement plans:** an orientation list (TOPAZ) or a rotation scan of one axis (CORELLI, optionally
  interleaved with the half-way steps; chopper spectrometers with exact crossings). Completeness is cumulative over
  the plan. The reciprocal slice shades each point of a lattice plane by the number of settings that record it
  (λ in the band and k_f on a panel).
- **Suggested orientation lists** (`src/core/instrument/plan.ts`, TOPAZ):
  - Candidates: a grid over the free axes within their ranges (one turn at most), with the smallest step from
    1°, 2°, 3°, 4°, 5°, 6°, 8°, 10°, … that keeps it under 6000 settings: 1° for ω alone, 5° for TOPAZ ambient ω and φ.
    The ranges are the catalog's unless the user sets goniometer limits (per instrument and axis; e.g. collisions or
    the sample environment). The limits apply everywhere the goniometer is used: sliders, Suggest, Fill evenly,
    Find a setting and the exact coverage. Listed settings outside them are flagged.
  - Each candidate records the families of the reflections whose Laue λ is in the band and whose k_f hits a panel (the
    single-crystal test above; each panel's angular extent is checked first, exactly, from its corners). Tested
    reflection by reflection against `observeAt` on the real TOPAZ panels.
  - A recording of a wanted reflection is **well placed** when |λ − λ_mid| ≤ f·(λ_max − λ_min)/2 and the hit lies at
    least m of the panel's width and height from every edge (|x| ≤ (1 − 2m)·w/2, |y| ≤ (1 − 2m)·h/2); f = 0.5 and
    m = 0.1 by default, both editable. This is how TOPAZ users choose settings for wanted peaks.
  - Greedy selection: each pick maximises the wanted reflections it places well for the first time, then those it
    records for the first time, then the new families, then the families it records a second and a third time, then
    the families it records. Settings already in the list count as measured.
    Greedy maximum coverage is within (1 − 1/e) of the best for the same number of settings (Nemhauser, Wolsey &
    Fisher, Math. Program. 14, 265 (1978)).
  - A wanted reflection counts when any symmetry equivalent in the reflection list is recorded. An hkl outside the
    list (absent, weak, or beyond the 6000 strongest) is targeted as that exact hkl.
  - Not modelled: detector gaps inside a panel, masks, sample-environment shadows, and counting statistics.
  - Test: for P-1 families to d = 0.78 Å on a 5.431 Å cell, the suggestions record all 364 families after 8 settings,
    against 295 for ten settings evenly spaced in ω.
- **Time of flight of a spot:** t = (m_n/h)·(L1 + L2)·λ, with L2 to the pixel. This is Mantid's TOF ↔ λ relation,
  with no emission-time offset (T0_SHIFT = 0 in the TOPAZ_3007 peaks file).
- **Powder (sample fixed):** a pixel at 2θ records d from λ_min/(2 sin θ) to λ_max/(2 sin θ). A spacing d reaches
  2θ from 2 asin(λ_min/2d) to 2 asin(min(1, λ_max/2d)), and a panel records it when its 2θ span overlaps that range.
  Panel 2θ spans come from a 9 × 9 grid over the face.
- **Simulated pattern of one panel:** the panel is treated as one bank at the 2θ of its centre, with
  DIFC = (m_n/h)·(L1 + L2)·2 sin θ (no DIFA or ZERO) and the TOF intensity and shapes of §7b, using Gaussian peaks of
  constant Δd/d. Real banks are calibrated, and their resolution varies with angle.
- **Powder rings on the detectors.** An element at 2θ with flight path L = L1 + L2 records d = λ/(2 sin θ), where
  λ = t/((m_n/h)·L) in a time-of-flight slice at time t, or the incident λ for a monochromatic beam. The counts per
  unit solid angle from one d-group (Σ|F|² over its signed hkl), with the line a unit-area Gaussian G in ln d, are:
  - TOF slice, incident spectrum normalised out: Σ|F|²·d⁴·sin θ·G. This is the GSAS-II TOF Lorentz factor per unit
    solid angle. A line of power P(λ) ∝ λ³Σ|F|²/(2 sin θ) per cone, spread over 2π sin 2θ of solid angle, swept
    through dλ = d cos θ d(2θ) by the white beam, gives λ⁴Σ|F|²/sin³θ ∝ d⁴ sin θ·Σ|F|².
  - Fixed λ: Σ|F|²·G/(4 sin³θ). This is the CW Lorentz factor 1/(sin θ sin 2θ) per unit ring length, with the line
    profile converted from 2θ to ln d (|d ln d/d2θ| = cot θ/2).
  - Line FWHM in d: √((Δd/d)² + w²), with w the slice width Δt/t, or ΔE/(2E) for a monochromatic beam.
  - Images are scaled to the brightest element of the slice and shown on a square-root scale.
  - **Check:** `ringTrace` finds each ring independently by ray casting along every azimuth, solving
    t = (m_n/h)·(L1 + L2)·2d·sin θ with L2 from the panel hit. The tests require each traced point to fall in a
    panel-image cell, and a map cell, at its own 2θ within that cell's angular size, on the real NOMAD and POWGEN
    geometry. They also check that the cone power at fixed λ is ∝ 1/sin θ, and that the time-integrated TOF line is
    ∝ sin θ.
- **Focused banks** (NOMAD, POWGEN; `src/core/instrument/focus.ts`), as the data are reduced:
  - Groupings: NOMAD's six physical banks are the IDF assemblies Group1–Group6 (bank1–14, 15–37, 38–51, 52–63,
    64–81, 82–99), the groups CreateGroupingWorkspace builds with GroupDetectorsBy = 'Group'. POWGEN is focused to one
    bank of all 40 panels (every pixel is group 1 in the PG3 calibration of Mantid's test data). Mantid ships no
    grouping file for either: the site calibration files carry the groups, and they can exclude packs, which is not
    modelled.
  - Each panel is split into 4 × 8 cells, each with its own 2θ, L2 and solid angle Ω = A·|cos α|/L2². A line at d has
    I = Σ|F|²·d⁴·⟨sin θ⟩(d), the mean of sin θ over the cells that record d, weighted by Ω. This is what summing the
    sample and dividing by the summed vanadium gives, since vanadium scatters isotropically. A one-cell bank reduces to
    the single-panel formula above (tested).
  - Lines are drawn at t = DIFC_f·d. The bank's DIFC uses the effective L2 and 2θ that Mantid's focusing assigns from
    the characterisation file: NOMAD 2 m and 15, 31, 67, 122, 154, 7° (the 2011 example in Mantid's
    PDLoadCharacterizations docs, and the autoreduction bank labels); POWGEN 3.18 m and 90° with L1 = 60 m, so
    DIFC = 22585.7 µs/Å, as the 2024–25 autoreduction's FinalDIFC 22585.8. Current characterisation files may differ.
  - Tested: every NOMAD pack in exactly one bank, the solid-angle-weighted 2θ of each NOMAD bank within 6° of its
    nominal angle, and POWGEN's DIFC.
- **Chopper spectrometers** (ARCS, SEQUOIA, CNCS), elastic scattering at the incident energy:
  - λ = √(81.804 meV·Å²/Ei).
  - The band is λ·(1 ± ΔE/4E), i.e. Δλ/λ = ΔE/2E split about λ.
  - Single crystals rotate about the vertical axis ψ (counter-clockwise, Mantid sense +1).
  - A monochromatic rotation scan solves the Bragg condition exactly instead of stepping. Rotating about one axis
    keeps |q| and makes q_z = C + P cos ψ + Q sin ψ, with C, P, Q from ψ = 0°, 90° and 180°. Setting
    q_z = −λ|q|²/2 gives at most two angles per turn. These crossings are binned into the scan steps, so no
    reflection is missed between steps. Tested against a brute-force 0.01° scan.
  - The elastic powder pattern is intensity per unit solid angle against 2θ: Σ|F|²/(sin²θ cos θ), with Gaussian
    peaks of FWHM 2 tan θ·√((Δd/d)² + (ΔE/2E)²). It is zero where no panel covers 2θ.
  - Coverage from the Mantid IDFs is tested against the ORNL spec sheets (Dec 2021):
    - ARCS: −28° to 135°, −27° to 26°.
    - SEQUOIA: −30° to 60°, and ±18° for rows B–D; the A row reaches −30° vertically.
    - CNCS: ±16° vertically. ORNL quotes −50° to +140° horizontally; the current IDF spans −53.6° to 132.6°.

## 11. Scattering power (comparing materials)

On the Structure page; code in `src/core/scattering/power.ts`. Everything is per unit volume of material, so no
flux, detector or counting-time model enters, and a powder's packing fraction scales all values equally.

- **Macroscopic cross-sections:** Σ = (1/v_c)·Σ_sites m·o·σ for the coherent, incoherent and absorption cross-sections
  of Sears (1992), in barn. With v_c in Å³, 1 b/Å³ = 10⁻²⁴ cm²/10⁻²⁴ cm³ = 1 cm⁻¹. The 1/e attenuation length is
  1/(Σ_coh + Σ_inc + Σ_abs). Absorption follows the 1/v law, σ_abs(λ) = σ_abs(2200 m/s)·λ/1.798 Å. Resonant
  absorbers (Gd, Sm, Cd, …) are flagged, because the law does not hold for them away from 1.798 Å.
- **Bragg line strength:** j|F|²/v_c² (fm²/Å⁶), with j|F|² the sum of |F|² over the line's signed hkl. It is the
  sample's factor in a line's integrated intensity per unit volume. The Lorentz, flux and detector factors depend only
  on d at a given detector, so at similar d the ratio of strengths is the ratio of line intensities for equal sample
  volumes.
- **TOF weighting:** j|F|²d⁴/v_c² (fm²/Å²). At a fixed detector angle the TOF Lorentz factor λ⁴/sin²θ is ∝ d⁴ (§10).
  Ranking lines by it matches a measured TOF pattern apart from the source spectrum. Unweighted, the
  high-multiplicity silicon (4 2 2) line is the strongest; weighted, (1 1 1) is, as measured. Both cases are tested.
- **Reference standards** (COD CIFs in `fixtures/cif/`, fetched only when chosen). The tests pin each cell
  against a certified or literature value, the cell contents, and Σ against hand sums of the Sears values:
  - Vanadium, COD 9012770 (James & Straumanis 1960, via AMCSD): a = 3.0241 Å, 0.11% below NBS Monograph 25
    (3.0274 Å; vanadium's cell depends on dissolved O, N and H). No ADPs (B = 0); its Bragg lines are negligible
    (Σ_inc/Σ_coh ≈ 280).
  - Diamond, COD 2300702 (Houben et al. 2023, neutron TOF on POWGEN): a = 3.566636(7) Å, −98 ppm from Hom et al.
    (1975).
  - Silicon, COD 2104737 (Elliot 2010): a = 5.43096(6) Å.
  - CeO₂, COD 4343161 (Artini et al. 2015, synchrotron): a = 5.40972(11) Å, −334 ppm from NIST SRM 674b
    (5.41153 Å).
  - Corundum, COD 9007496 (Lewis, Schwarzenbach & Flack 1982): a = 4.7602, c = 12.9933 Å, +178 and +76 ppm from
    NIST SRM 676a; anisotropic ADPs enter as U_eq.
- **Not a counting time.** Flux, detector efficiency, background and sample environment vary by instrument and
  experiment. The comparison only says how a sample scatters relative to a known material.
