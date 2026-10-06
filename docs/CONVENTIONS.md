# Scientific conventions

Frozen for NEXPLAN 0.1. Changing anything here is a breaking change and needs a changelog entry and the full
regression suite. Each item names the code that implements it and the test that holds it, and cites the
literature it follows; full references are in [§12](#12-references).

Revised 2026-10-06 after a code review that re-derived the formulas against the literature and the pinned upstream code
(Mantid, GSAS-II, garnet-tools, PyChop, gemmi). Its changes are listed in [§13](#13-changes-from-the-2026-10-06-audit).

## 1. Units

- Lengths are in Å and reciprocal lengths in Å⁻¹. Angles are entered and displayed in degrees and computed in
  radians.
- X-ray amplitudes are in electrons and neutron amplitudes in fm, so |F|² is in e² or fm² per conventional cell. The
  two are never put on a common absolute scale.

## 2. Lattice

- The direct basis A has the lattice vectors a, b, c as columns, and r = A·x for fractional coordinates x
  (ITC Vol. B §1.1).
- The metric is G = AᵀA. G is computed in MATERIA's `metricTensor`; NEXPLAN uses its copy in `src/materia/`.
- The reciprocal basis is C = A⁻ᵀ, without 2π. Then g = C·h, 1/d² = hᵀG⁻¹h and Q = 2π/d.
- s = sinθ/λ = 1/(2d). The scattering tables use this variable.
- Basis change, with ITA's convention (a′, b′, c′) = (a, b, c)·P, i.e. A_new = A_old·P (Arnold, ITA Vol. A §5.1):
  - x_new = P⁻¹(x_old − p)
  - h_new = Pᵀh_old
  - UB_new = UB_old·P⁻ᵀ
  - G_new = PᵀG_old·P

## 3. Symmetry

- An operation is x′ = R·x + t, with R an integer matrix and t in multiples of 1/24.
- Parsing is exact. Text is never evaluated as code. Translations must be multiples of 1/24: a fraction that is not
  is rejected, and a decimal within 10⁻⁴ of some k/24 is snapped to it (0.3333 → 1/3) (`src/core/symmetry/ops.ts`).
- Reflection h is systematically absent iff some operation (R, t) of the full group, including centring, has
  hᵀR = hᵀ and h·t ∉ ℤ, since F(hᵀR) = exp(−2πi h·t)·F(h) (ITC Vol. B §1.4). This is integer arithmetic.
  - Test: equality with gemmi `is_systematically_absent` for every one of the 564 settings, |h|, |k|, |l| ≤ 4.
- The setting is never guessed. An H-M symbol shared by several settings (origin choice 1/2, rhombohedral vs.
  hexagonal axes without a decisive cell, monoclinic cell choices) needs explicit operations, a Hall symbol, or the
  user's choice. A Hall symbol that contradicts the H-M symbol is an error (`src/core/symmetry/spaceGroups.ts`).
- An operation list that omits the centring translations is completed from the symbol's lattice letter, but only
  when the list has no centring of its own: a list in the reverse rhombohedral setting under "R" is used as given,
  not given the obverse centring as well. Test: R 3 reverse, 9 operations, h − k + l = 3n (ITA Table 2.2.13.1).

## 4. Structure factor

F(h) = Σⱼ oⱼ · aⱼ(s) · exp(−Bⱼ s²) · exp(+2πi h·xⱼ)

- The sum runs over the expanded cell. o is the occupancy, B = 8π²U_iso and T = exp(−B s²) (Trueblood et al. 1996).
  A site with anisotropic ADPs enters with U_eq = ⅓ Σᵢⱼ U^ij a*ᵢ a*ⱼ aᵢ·aⱼ (Fischer & Tillmanns 1988), from the
  file's U_iso_or_equiv or computed from its U, B or β tensor: an isotropic approximation, exact for the
  orientational (powder) average only to first order in U.
- The phase sign is that of ITC Vol. B §1.2.
- Symmetry images closer than 0.02 Å are one position: every such pair is linked, and each connected group of images
  is replaced by its centroid (union–find; cf. Grosse-Kunstleve & Adams 2002). The operations are isometries that
  permute the images, so they permute the groups too and the centroids are symmetric whatever the order of the
  operations; a site given on a rounded special position (0.3333 for 1/3) still expands to an exactly symmetric
  arrangement. Test: P4, an atom 0.0105 Å off the 4-fold axis, in two operation orders.
- Images 0.02–0.5 Å apart are kept and reported.
- Test: complex F equal to gemmi 0.7.3 within 1e-8·Σ|o·a·T| + 1e-8·|F_gemmi| for five COD structures (neutron, real
  b), phases included. Complex amplitudes are tested analytically (§5).

## 5. Scattering amplitudes and the sign of complex b

- **X-rays:** a = f0(s) = Σ₁⁵ aᵢ exp(−bᵢ s²) + c from Waasmaier & Kirfel (1995), for 0 ≤ s ≤ 6 Å⁻¹. Outside that
  range the evaluator throws. There are no anomalous terms yet.
- **Neutrons:** Sears (1992) prints the bound coherent length as b = b′ − i b″ with b″ ≥ 0 for absorbing nuclei.
  That is the physics convention:
  - time dependence exp(−iωt);
  - Q = k_out − k_in;
  - scattered amplitude ∝ Σ (−b) exp(−iQ·r);
  - Im(−b) > 0 by the optical theorem (Sears 1989; Squires 2012, ch. 1–2): b″ = kσ_t/4π ≈ kσ_a/4π for a strong
    absorber, consistent with the printed values at 1.798 Å (Gd: 13.82 fm).
- **Why the conjugate.** The crystallographic convention, F = Σ f exp(+2πi h·x) with X-ray f″ > 0, is the complex
  conjugate of that amplitude. So the neutron term in F is **a = conj(b) = b′ + i b″**.
- **Where it lives.** The tables store b exactly as printed; `amplitudeFor` conjugates.
- **Tests:**
  - |F(h)|² from the code equals the physics-convention |Σ b exp(−2πi h·x)|² for a non-centrosymmetric Gd
    structure.
  - Using the printed b directly gives I(−h) instead.
  - Every absorbing nucleus (all 20 complex rows, elements and isotopes) gets a positive imaginary amplitude, the same
    sign as X-ray f″.
- **Consequences.** Powder intensities and centrosymmetric structures are unaffected by the sign. For
  non-centrosymmetric single crystals, the wrong sign reverses Bijvoet differences.

## 6. Reflections

- The full signed list is enumerated with |hᵢ| ≤ ⌊|aᵢ|/d_min⌋ per axis. This bound is exact, because hᵢ = aᵢ·g and
  |g| ≤ 1/d_min. Reflections are then filtered by d ≥ d_min.
- Exceeding the reflection limit is an error. The list is never truncated.
- **Classes:**
  - *systematic*: from the operations;
  - *accidental*: |F| ≤ 1e-8·Σ|o·a·T| although the space-group operations allow the reflection. This takes every
    zero the operations do not force: the special reflection conditions of occupied Wyckoff positions as well as
    chance cancellations;
  - *present*: everything else.
- Example: in diamond Si, (200) is systematic (the d-glide) and (222) is "accidental": it vanishes by the special
  condition of Wyckoff position 8a in Fd-3m (all-even hkl need h + k + l = 4n; ITA Vol. A).
- Friedel pairs are kept separate whenever any amplitude is complex.

## 7. Powder (constant wavelength)

- **Intensity.** For each distinct d (|Δd| ≤ 1e-9·d), I = Σ|F|² over every signed hkl at that d. No multiplicity
  factor enters the intensity. Families (orbits under the point group, merged with Friedel mates when amplitudes are
  real) supply labels and multiplicities only.
- **Lorentz factor.** L = 1/(sin²θ cosθ), for Debye–Scherrer and Bragg–Brentano (Warren 1969, ch. 4; ITC Vol. C
  ch. 6.2; GSAS-II uses the same up to a constant). A line within 0.02° of 2θ = 180° (cos θ < 10⁻⁴) is left out:
  its cone closes onto the incident beam, where L diverges and nothing is recorded.
- **Polarization (X-rays only):**
  - unpolarized: (1 + cos²2θ)/2;
  - monochromator: (1 + cos²2θ_M cos²2θ)/(1 + cos²2θ_M), for a mosaic crystal whose scattering plane is that of the
    sample (a lab diffractometer's graphite monochromator; Azároff 1955). A perpendicular arrangement would give
    (cos²2θ_M + cos²2θ)/(1 + cos²2θ_M). Graphite 002 (d = 3.354 Å): 2θ_M = 26.6° for Cu Kα, 12.1° for Mo Kα;
  - linearly polarized, fraction f perpendicular to the scattering plane: f + (1 − f)cos²2θ (as GSAS-II's
    polarization with Azm = 0). A synchrotron's horizontally polarized beam on a vertical scattering plane has f ≈ 1;
    on a horizontal plane f ≈ 0.
  - Neutrons get no polarization factor.
- **Profiles.** Each peak is a unit-area pseudo-Voigt (MATERIA `pseudoVoigt`; Thompson, Cox & Hastings 1987) times
  the integrated intensity, cut at ±40 FWHM (which drops 1 − (2/π)·atan 80 ≈ 0.8 % of the Lorentzian fraction η of
  its area). The pattern is synthesized natively on the chosen axis (2θ, d or Q) with the FWHM in that axis's units:
  a constant width on any axis, a display choice rather than an instrument model.
- **Not modelled:** absorption, texture, extinction, sample displacement and asymmetry.

## 7b. Powder (neutron time-of-flight, one detector bank)

- **Position** (GSAS-II `GSASIIlattice.py` Dsp2pos; Toby & Von Dreele 2013): t = ZERO + DIFC·d + DIFA·d² in µs
  (GSAS-II's DIFB/d term is 0).
- **DIFC from geometry** (Mantid `Unit.cpp`): DIFC = (m_n/h)·L·2 sinθ. Here m_n/h = 252.778 413 µs/(m·Å)
  (CODATA 2018, Tiesinga et al. 2021; agrees with Mantid's CODATA 2006 value to 8×10⁻⁹), L = L1 + L2 and 2θ is the
  bank angle.
  Calibrated DIFC/DIFA/ZERO from an instrument file override the geometry.
- **Wavelength band.** A bank sees d = λ/(2 sinθ) for λ in [λmin, λmax]. Each peak has its own λ = 2d sinθ.
- **Intensity** (GSAS-II `GSASIIstrMath.py`, "TOF Lorentz correction"; Von Dreele, Jorgensen & Windsor 1982;
  Jorgensen & Rotella 1982): I = Σ|F|² · sinθ · d⁴, the line area on the TOF axis. This is for data normalized by
  the incident spectrum; the spectrum and detector efficiency are not modelled.
- **Peak shapes.**
  - Constant relative resolution: a Gaussian with FWHM_t = (Δd/d)·t.
  - GSAS-II back-to-back exponentials ⊗ Gaussian (MATERIA `tofBackToBack`, unit area; Von Dreele, Jorgensen &
    Windsor 1982), with α = α₁/d, β = β₀ + β₁/d⁴ + β_q/d² and σ² = σ₀ + σ₁d² + σ₂d⁴ + σ_q·d (µs²), as GSASIIpwd.py.
    There is no Lorentzian γ term yet. Widths quoted for this shape use GSAS-II's getFWHM, 2.355σ + ln2·(α + β)/(αβ),
    which adds the two widths and overstates the profile's true FWHM by 6–10 % for POWGEN's 0.8 Å frame; a "≥ 1 FWHM
    apart" verdict with it errs on the side of overlap.
- **Grid and axes.** The pattern is built on a logarithmic TOF grid (constant Δt/t). On a d or Q axis the same values
  are relabelled (d from t; Q = 2π/d), not transformed with a Jacobian: vanadium-normalized data are a ratio of counts
  per bin, which a change of axis does not alter (as Mantid's ConvertUnits keeps a histogram's values). Line areas
  then go as Σ|F|²·d⁴ on d and Σ|F|²·d² ∝ Σ|F|²/Q² on Q, the powder cross-section. Tested: the d and Q values equal
  the TOF values, and the areas are I/(dt/dd) and I·2π/((dt/dd)·d²) to first order in the line width.
- **Resonant nuclei.** Complex b (Sears) is valid near 2200 m/s only. TOF spans many wavelengths, so resonant
  absorbers are flagged.

## 7c. Wavelength and energy

- X-rays: E = hc/λ, with hc = 12.398 419 843 keV·Å.
- Neutrons: E = h²/(2m_nλ²), with h²/2m_n = 81.8042 meV·Å² (k² = 0.482596·E in Å⁻² and meV, k = 2π/λ).
- Both use CODATA 2018 (Tiesinga et al. 2021). λ is the stored quantity; energy is a view of it.

## 7d. X-ray form factors and ions

- Every site uses the neutral-atom Waasmaier–Kirfel f0 by default, whatever charge its CIF type symbol gives: ionic
  and neutral f0 differ only at low s, and some ionic forms (O²⁻) are ill-defined. Programs differ on this choice;
  NEXPLAN takes the neutral atom unless told otherwise.
- A site switches to a tabulated ionic f0 only by an explicit per-site choice, which is recorded as an assumption.
  Free O²⁻ in particular is ill-defined; see `data-verification/XRAY_WK1995.md`.
- Neutron b never depends on the charge.

## 8. Orientation, goniometers and the Laue condition

- UB maps a column hkl to g in the sample frame, without 2π (Busing & Levy 1967; Mantid `OrientedLattice`). Sample
  rotations act on the left; basis changes act on the right. Q_lab = 2π·R·UB·h.
- **ISAW UB files** (Mantid `SaveIsawUB.cpp` at the pinned commit):
  - the file stores UBᵀ;
  - its frame is the IPNS frame: x is the beam, z is up, right-handed;
  - |Q′| = 1/d;
  - Mantid's frame relates to it by z_M = x_I, x_M = y_I, y_M = z_I.
- **Q sign and Miller indices** (mantid @ 67c2f43):
  - Mantid's UB uses the inelastic convention, q = (k_i − k_f)/2π = UB·h (`OrientedLattice.cpp:88-91`), and the
    default `Q.convention` is Inelastic.
  - UB keeps its sign across conventions: LoadIsawUB and SaveIsawUB never change it (`LoadIsawUB.cpp:129-159`,
    `SaveIsawUB.cpp:126-136`), while ISAW peaks I/O multiplies hkl by qSign = −1 under Inelastic
    (`LoadIsawPeaks.cpp:427-432`, `SaveIsawPeaks.cpp:292-294, 356-363`). So a convention change flips the hkl
    labels, not UB. (The indexer's right-handed basis, `IndexingUtils.cpp:1846-1850`, does not by itself imply
    this: a fresh indexing may return (−a, −b, c).)
  - For crystallographic indices, which NEXPLAN uses, q_cryst = k_f − k_i = UB·h. Mantid's default labels the same
    reflection (−h −k −l). MD histograms index with the same UB, so under the default the data NEXPLAN places at
    (h k l) appear at (−h −k −l); the Binning card writes its MDNorm limits for the convention chosen there (§10).
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
- **Basis change** (ITA): UB′ = UB·P⁻ᵀ and h′ = Pᵀh. A loaded UB is mapped onto the CIF cell, UB_CIF = UB·Pᵀ, by a
  right-handed P with Pᵀ·G_CIF·P ≈ G_UB within 2 % of G_UB's largest entry (`findCellMatches`).
  - The volume ratio fixes det P: n = 1 for the CIF cell in another setting, a whole n for a supercell (8 for
    2 × 2 × 2), 1/n for a smaller cell. P (or, for a smaller cell, P⁻¹ in the UB's cell) is a whole matrix whose
    columns are lattice vectors with the target's lengths; a vector's index along a_i is a*_i·v, so |index| ≤
    |v|·|a*_i| bounds the search (at most 12).
  - P and W·P, for W a proper rotation of the CIF's Laue group (R, or −R for improper R), index the reflections
    alike, so each such set counts once. What remains are real alternatives, e.g. the axis of a pseudo-cubic
    supercell that is the CIF's c, offered as a choice. Best misfit first; misfits within 0.2 % of each other count
    as equal, and then the plainest P (fewest off-diagonal and negative entries) comes first.
  - Tested on 2 × 2 × 2, √2 × √2 × 1 and 2 × 1 × 1 supercells, the primitive cell of an F lattice, a pseudo-cubic
    tetragonal supercell (three choices) and a strained UB, and through an ISAW file.
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
- **Pixels** follow the ISAW peaks-file convention, col = (x/w + ½)·n_cols + ½, with x measured along `base` from the
  panel centre (rows likewise along `up`), so pixel centres sit at 1 … n. Mantid's own Peak Row/Col of a rectangular
  detector are 0-based pixel indices, round(col) − 1 (`Peak.cpp:255-260`, `RectangularDetector::getXYForDetectorID`).
- **Defaults** follow Mantid's parser (`InstrumentDefinitionParser.cpp`): each component of a rotation axis defaults
  on its own, axis-z to 1 (so axis-x="1" alone is (1, 0, 1)), and idstepbyrow to the pixel count along the fill
  direction. Not read, and not used by any shipped definition: `<locations>`, angles in radians,
  `spherical="delta"` offsets, and a sample away from the origin.
- **Validation** on Mantid's TOPAZ_3007 (`src/core/instrument/detectors.test.ts`):
  - The reader applied to the IDF valid for that run reproduces the 13 panel geometries Mantid wrote into the peaks
    file: centres to 0.001 mm, axes to 1.6×10⁻⁴ (tested to 5×10⁻⁴).
  - Every observed peak lands on its recorded detector within 0.1 pixel.
  - Peaks predicted from UB and the goniometer land on the right detector, within the UB fit's angular residual
    (≤ 5.4 pixels).
- **Instruments:** TOPAZ (2022-11-21), CORELLI (2017-04-04), NOMAD (2022-05-05), POWGEN (2018-05-05), ARCS (2012-10-11),
  SEQUOIA (2019-04-04) and CNCS (2026-02-02) definitions at Mantid commit 67c2f43, generated into
  `src/data/instruments.json` and loaded with the Instrument page.

## 10. Instrument simulations

On the simulation pages (Detectors, Powder, Single crystal) for the SNS instrument chosen in the header (always
neutron scattering); code in
`src/core/instrument/simulate.ts` and `src/core/instrument/powderRings.ts`.

- **Detector map:** directions are unrolled about the vertical axis and plotted equirectangularly,
  γ = atan2(u_x, u_z) (0 along the beam, +90° towards +x) against ν = asin(u_y). (Mantid's cylindrical instrument
  view is the equal-area version, with sin ν upwards: `UnwrappedCylinder.cpp`.) A cone of constant 2θ satisfies
  cos 2θ = cos γ · cos ν.
- **Single crystal:** at goniometer setting R, reflection h is on a detector when its Laue wavelength (§8) is in the
  band and the ray along k_f hits a panel (§9). A rotation scan steps one axis with the others fixed. Completeness is
  the fraction of symmetry families with at least one member seen so far, over the families among the simulated
  reflections (the strongest 6000 present with d ≥ d_min). Friedel mates are merged only when the amplitudes are
  real.
- **Reflection coverage** (single crystal; after the "individual peak" coverage of NeuXtalViz's experiment planner,
  neutrons/NeuXtalViz-tools models/experiment_planner.py @ 655afa3): every detector position where the chosen
  reflection can be recorded, optionally with its symmetry equivalents, as the free goniometer axes sweep their
  ranges.
  - Each point is coloured by its wavelength, λ = 2d sin θ at that pixel.
  - White-beam instruments use a grid of settings: 1° steps, doubled for each extra free axis, each axis at most one
    turn. A setting counts when λ = −2q_z/|q|² is in the band and k_f hits a panel.
  - Chopper spectrometers use the exact Bragg crossings instead.
  - Tested: every point satisfies λ = 2d sin θ at the pixel it hits, and lies in the band.
- **Exact coverage** (`src/core/instrument/coverage.ts`): per detector pixel, the pixel fixes q̂ ∝ u − ẑ and
  λ = 2d sin θ; with R = M₀·Rot(n₁, s₁a)·M₁·Rot(n₂, s₂b)·M₂ (fixed axes in the M's), the component of the rotated
  reflection along n₁ is a sinusoid in b, giving at most two b per turn, each with one a; both are checked against
  the axis ranges.
  - A pixel has a finite size, so each condition (on the cone about n₁, and along it) holds within the pixel's
    reach in that condition's direction. With q̂ = (cos θ cos φ, cos θ sin φ, −sin θ), a step of the scattered
    direction by α along 2θ and β azimuthally moves q̂ by α/2 and β/(2 sin θ): q̂ moves half as fast as k_f along 2θ
    but faster azimuthally below 2θ = 60°. A condition's tolerance is therefore the pixel's extent (to first order,
    its support function, from the pixel's two half-sides) along the k_f-direction that changes it.
  - A ray stops at the nearest panel (NOMAD, SEQUOIA and CNCS have overlapping panels).
  - Tested by rotating forward to the returned angles, against the stepped sweep, against the ω-only and χ = 135°
    analytic cases, against the exact rule |ν| ≤ half-size for an ω-only track at 2θ = 10–150°, and against a 0.002°
    ω sweep on the real TOPAZ panels (no swept cell missed beyond one per reflection). The Detectors page draws this
    map: the beam turns twice as fast as the crystal, so a map drawn from NEXPLAN's stepped sweep left empty
    pixels between its points. *Find a setting* still uses the stepped sweep.
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
    m = 0.1 by default, both editable: the middle half of the band, and at least a tenth of the panel from each edge.
  - **Full coverage** (greedy selection): each pick maximises the wanted reflections it places well for the first
    time, then those it records for the first time, then the new families, then the families it records a second and
    a third time, then the families it records; it stops when a pick adds nothing. Settings already in the list count
    as measured.
  - Guarantee: the first goal is a coverage function, monotone and submodular, and each pick maximises it first, so k
    picks place at least 1 − (1 − 1/k)^k ≥ 1 − 1/e as many wanted reflections well as the best k grid settings would
    (added to those listed); with none wanted, the same holds for families recorded (Nemhauser, Wolsey & Fisher
    1978). Completeness and redundancy then only break ties and carry no guarantee, and the comparison is with the
    grid, not with continuous angles.
  - **Fewest settings** (greedy set cover): each pick places the most wanted reflections well for the first time,
    then records the most for the first time, then has the lowest summed placement cost (distance from mid band and
    from the panel centre), then the most new families; it stops when no wanted reflection gains (with none wanted,
    when no family is new). Each pick is then fine-tuned off the grid without lowering any wanted reflection's level.
    Until every wanted reflection that some grid setting places well is placed well, it uses at most
    H(n) ≤ ln n + 1 times the fewest grid settings that do so (Johnson 1974; Lovász 1975; Chvátal 1979); settings
    added afterwards only to record the rest are outside that bound.
  - A wanted reflection counts when any symmetry equivalent in the reflection list is recorded. An hkl outside the
    list (absent, weak, or beyond the 6000 strongest) is targeted as that exact hkl.
  - Not modelled: gaps between the tubes of a pack (packs are fitted rectangles), and counting statistics. Masks and
    shadows apply as set (below).
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
  - Each panel is split into 4 × 8 cells, each with its own 2θ, L2 and solid angle Ω = A·|cos α|/L2². Cell c records
    a line at d (at λ_c = 2d sin θ_c) with N_c ∝ φ(λ_c)·λ_c⁴·Ω_c·Σ|F|²/sin³θ_c counts (φ the incident spectrum), and
    vanadium, an isotropic scatterer, gives φ(λ_c)·Ω_c·2 sin θ_c per unit d. Focusing sums both over the cells and
    divides; spectrum, angle and solid angle cancel cell by cell, so the normalized line has area ∝ Σ|F|²·d⁴ in d,
    and I = Σ|F|²·d⁴·sin θ_f on the focused TOF axis (×DIFC_f): the GSAS-II TOF Lorentz factor at the bank's effective
    angle, as GSAS-II fits focused data. A line is drawn when some cell records it.
  - Tested: a one-cell bank reduces to the single-panel formula above, and the focused intensities equal
    sample-over-vanadium sums done count by count for an arbitrary spectrum.
  - Lines are drawn at t = DIFC_f·d. NOMAD: the calibrated DIFC of ORNL's 2023A GSAS-II instrument file for banks 1–5
    (banks 2–5 at 2θ 31, 65, 120.4, 150.1° and flight paths 21.18, 20.66, 20.61, 20.29 m; bank 1's angle and path there
    are placeholders, so 15° is nominal); bank 6 (7°) is not in that file and uses the geometric DIFC. POWGEN: L2 3.18 m
    and 90° with L1 = 60 m (characterisation file), DIFC = 22585.7 µs/Å, as the 2024–25 autoreduction's FinalDIFC
    22585.8.
  - **Peak widths** from the instrument where ORNL publishes them (or the bar's Δd/d, by choice):
    - NOMAD: the measured Δd/d (FWHM) per bank of ORNL's NOMAD overview (slide 5, 2014, when 50 of the 99 eight-packs
      were installed, slide 3): 2.9, 1.9, 1.37, 0.69, 0.36, 3.9 % for banks 1–6, as constant-width Gaussians. The 2023A
      GSAS-II profiles give similar widths (within 10–25 %) but include Lorentzian terms that the app's TOF profile does
      not.
    - POWGEN: ORNL's 2026B GSAS-II instrument files (high-resolution guide, 60 Hz) for the 0.8, 1.5 and 2.665 Å
      frames, as GSAS-II's TOF profile: back-to-back exponentials, α = alpha/d and β = beta-0 + beta-1/d⁴ +
      beta-q/d², convolved with a Gaussian of σ² = sig-0 + sig-1·d² + sig-2·d⁴ + sig-q·d (GSASIIpwd.py getFWHM; the
      files have no Lorentzian). Δd/d grows with d: for the 0.8 Å frame 0.22 % at 1 Å and about 1 % at 4 Å by GSAS-II's
      FWHM formula (§7b; the profile's own FWHM is about 10 % less), within 25 % of the LaB6 resolution measured by
      Huq et al., J. Appl. Cryst. 52, 1189 (2019), Fig. 6 (tested). Below the
      shortest d where the fitted σ² and β are positive, the parameters at that d are used.
  - Tested: every NOMAD pack in exactly one bank, the solid-angle-weighted 2θ of each NOMAD bank within 6° of its
    nominal angle, and POWGEN's DIFC.
- **Chopper spectrometers** (ARCS, SEQUOIA, CNCS), elastic scattering at the incident energy:
  - λ = √(81.804 meV·Å²/Ei).
  - The band is λ·(1 ± ΔE/4E), i.e. Δλ/λ = ΔE/2E split about λ.
  - Single crystals rotate about the vertical axis ψ (counter-clockwise, Mantid sense +1).
  - A monochromatic rotation scan solves the Bragg condition exactly instead of stepping. Rotating about one axis
    keeps |q| and makes q_z = C + P cos ψ + Q sin ψ, with C, P, Q from ψ = 0°, 90° and 180°. Setting
    q_z = −λ|q|²/2 gives at most two angles per turn. Each crossing is counted in the scan step nearest
    to it. Tested against a brute-force 0.01° scan.
  - The elastic powder pattern is the intensity per unit solid angle against 2θ, each line of area (over 2θ)
    Σ|F|²/(sin²θ cos θ), a Gaussian of FWHM 2 tan θ·√((Δd/d)² + (ΔE/2E)²). It is zero where no panel covers 2θ. (The
    rings painted on the detectors carry the same line with its profile in ln d, hence Σ|F|²/(4 sin³θ): the two
    differ by |d ln d/d2θ| = cot θ/2.)
  - Coverage from the Mantid IDFs is tested against the ORNL spec sheets (Dec 2021):
    - ARCS: −28° to 135°, −27° to 26°.
    - SEQUOIA: −30° to 60°, and ±18° for rows B–D; the A row reaches −30° vertically.
    - CNCS: ±16° vertically. ORNL quotes −50° to +140° horizontally; the current IDF spans −53.6° to 132.6°.

- **Masks and shadows** (`src/core/instrument/acceptance.ts`), applied by every hit test (single-crystal spots,
  scans and lists, the planner, exact and stepped coverage, powder rings, focused banks):
  - A mask is a per-pixel bitmap on each panel, row-major from pixel (1, 1) in the peaks-file numbering of §9:
    edge pixels (rows at the tube ends or panel top and bottom, columns at the sides), panels switched off, and the
    detector IDs and components of a Mantid mask file (SaveMask XML; `<ids>` spectrum numbers are refused).
  - Detector IDs follow the IDF (`scripts/data/idf.ts`): an `idlist` hands out its IDs in document order to the
    detectors and monitors under its component and must be used up exactly; a rectangular detector numbers pixel
    (i, j) as idstart + i·idstepbyrow + j·idstep when filled along y first (the default). Each panel's IDs are
    stored as id = start + column·a + row·b, checked pixel by pixel when the tables are built, and unique per
    instrument (TOPAZ bank n starts at n·65536; CORELLI bank n at (n − 1)·4096, 256 per tube).
  - A ray stops at the first panel it meets: a masked pixel is not recorded and hides nothing behind it.
  - A shadow blocks directions in the detector-map angles (γ, ν) of the environment's frame: an opening keeps
    |ν| ≤ ν₀, a leg blocks |γ − γ₀| ≤ Δγ at every ν, a box blocks γ₁…γ₂ × ν₁…ν₂. Fixed in the lab, or mounted on
    goniometer axis k so that it turns with axes 0…k (R = R₀·R₁·…, axis 0 outermost): a lab direction u is tested
    at (R₀…R_k)ᵀ·u. Exact coverage tests stage-mounted shadows at each solution's angles. Powder pages use the
    current setting (the sample does not turn).
  - Focused banks count, per cell, only the pixels that record, at their centroid; with one cell per pixel this is
    exactly the pixel sum of solid angles (tested).
  - Tested: masks pixel by pixel, a masked front panel hiding the one behind, shadows across the ±180° seam and on
    a stage against the explicit rotation, the planner's compiled test reflection by reflection against
    `observeAt` with masks and shadows, coverage never in a shadow and solvable wherever the stepped sweep lands,
    and mask files mapping each ID to its own pixel (monitor IDs and unknown components reported, not placed).

- **Binning** (`src/core/instrument/hklRange.ts`, `binning.ts`, `qResolution.ts`, `pychop.ts`):
  - Range: a pixel along u records q = (u − ẑ)/λ (white beam) or q = k_f·u − k_i·ẑ (chopper spectrometer, energy
    transfer E, k = √(E/81.8042)); in the crystal x = (UB·W)⁻¹·Rᵀ·q along the projection axes W. Along a pixel q is
    linear in 1/λ or k_f, so the box over settings, recording pixels (masks and shadows applied) and band ends is the
    recorded extent; each segment is clipped exactly to |q| ≤ 1/d_min. Pixels are sampled on a grid per panel that
    includes its edges; the pixel direction is not linear in the position on a flat panel, so the extent is exact to
    second order in the grid spacing.
  - Q resolution, TOPAZ and CORELLI: Σ = k²[σ_γi(λ)²·x̂x̂ᵀ + σ_νi(λ)²·ŷŷᵀ + σ_γf²·γ̂fγ̂fᵀ + σ_νf²·ν̂fν̂fᵀ +
    (σ_dl² + σ_dlb²/λ²)·qqᵀ] + η²(Q²I − QQᵀ) (Stoica 1975; Forsyth 1988), as ORNL garnet-tools models peak shapes
    (`resolution.py` `_model_design_lab` @ 4eb3206), with its fitted DivergenceParams. These are in degrees on a
    99.7 % containment scale, so a Gaussian σ is the value / √χ²₃(0.997) = value / 3.7325 (χ²₃(0.997) = 13.93142).
    The mosaic term is the small-rotation result δQ = δω × Q, η a Gaussian σ (the card takes its FWHM). The
    calibration crystal's mosaic is dropped and the sample's η is an input. Tested against garnet's own code on the
    pinned file.
  - Energy resolution, ARCS, SEQUOIA, CNCS: Mantid PyChop's closed-form model at 67c2f43 (moderator, choppers, aperture,
    sample and ³He-tube depth propagated to the detector; Carlile, Taylor & Williams 1985; Perring 1991, 1993; the
    Ikeda–Carpenter moderator pulse, Ikeda & Carpenter 1985), with its arcs/sequoia/cncs.yaml parameters; tested against
    PyChop's output. The chopper setting in the header gives the elastic width ΔE/E = FWHM(0)/Ei for the simulations'
    band (Δλ/λ = ΔE/2E) as well. Defaults are PyChop's 300 Hz with ARCS-100-1.5, SEQ-100-2.0 or CNCS High Flux. A typed
    ΔE/E ("Custom") is kept, and so is the last width where a chopper does not transmit.
  - Q for chopper spectrometers (a geometric estimate; NEXPLAN has no Q-resolution model for them): outgoing angular
    σ from the median pixel and the sample size over L2 (uniform widths, σ = w/√12), physical angles along unit
    directions across k̂_f, the incident divergence if given, and σ_E as a spread 0.482596·σ_E/(2k_f) of |k_f| along
    k̂_f (dk/dE for k² = 0.482596·E).
  - Bins: FWHM along axis i is 2.3548·√C_ii, C = M·Σ·Mᵀ/(2π)², M = (UB·W)⁻¹·Rᵀ. These are sampled at up to 24
    settings, the pixel grid and 5 wavelengths (or energy transfers) where the plan records within d_min. The bin is
    the 25th percentile over the bins per FWHM (2 by default; 3 for energy, from the elastic FWHM), rounded to the
    nearest of 1, 2, 2.5, 5 × 10ⁿ (on a log scale, so the bins per FWHM are effectively within a factor √2 of the
    choice), and the range is rounded out to whole bins. A slice integrates one axis over 2 × its median FWHM.
  - MDNorm parameters (Mantid MDNorm v1: "min,step,max", or "min,max" to integrate) are written for the Mantid Q
    convention chosen in the card. For "Inelastic", Mantid's default, every limit is mirrored (−max … −min, the slab
    centre negated), since Mantid labels NEXPLAN's (h k l) as (−h −k −l) with the same UB (§8).

## 11. Scattering power (comparing materials)

On the Structure page; code in `src/core/scattering/power.ts`. Everything is per unit volume of material, so no
flux, detector or counting-time model enters, and a powder's packing fraction scales all values equally.

- **Macroscopic cross-sections:** Σ = (1/v_c)·Σ_sites m·o·σ for the coherent, incoherent and absorption cross-sections
  of Sears (1992), in barn (σ_coh = 4π|b|², 1 b = 100 fm²). With v_c in Å³, 1 b/Å³ = 10⁻²⁴ cm²/10⁻²⁴ cm³ = 1 cm⁻¹. The
  1/e attenuation length is 1/(Σ_coh + Σ_inc + Σ_abs). Absorption follows the 1/v law, σ_abs(λ) = σ_abs(2200
  m/s)·λ/1.798 Å. Resonant absorbers (Gd, Sm, Cd, …) are flagged, because the law does not hold for them away from 1.798
  Å.
- **Bragg line strength:** j|F|²/v_c² (fm²/Å⁶), with j|F|² the sum of |F|² over the line's signed hkl. It is the
  sample's factor in a line's integrated intensity per unit volume. The Lorentz, flux and detector factors depend only
  on d at a given detector, so at similar d the ratio of strengths is the ratio of line intensities for equal sample
  volumes.
- **TOF weighting:** j|F|²d⁴/v_c² (fm²/Å²). At a fixed detector angle the TOF Lorentz factor per unit solid angle,
  λ⁴/sin³θ = 16·d⁴·sin θ, is ∝ d⁴ (§10).
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

## 12. References

Crystallography and diffraction

- Arnold, H. (2002). Transformations of the coordinate system (unit-cell transformations). In *International Tables
  for Crystallography* Vol. A, 5th ed., ed. T. Hahn, ch. 5.1 (Table 5.1.3.1). Dordrecht: Kluwer.
- Azároff, L. V. (1955). Polarization correction for crystal-monochromatized X-radiation. *Acta Cryst.* 8, 701–704.
- Busing, W. R. & Levy, H. A. (1967). Angle calculations for 3- and 4-circle X-ray and neutron diffractometers.
  *Acta Cryst.* 22, 457–464.
- Fischer, R. X. & Tillmanns, E. (1988). The equivalent isotropic displacement factor. *Acta Cryst.* C44, 775–776.
- Grosse-Kunstleve, R. W. & Adams, P. D. (2002). On the handling of atoms on special positions. *Acta Cryst.* A58,
  60–65.
- Hall, S. R., Allen, F. H. & Brown, I. D. (1991). The Crystallographic Information File (CIF). *Acta Cryst.* A47,
  655–685.
- *International Tables for Crystallography* Vol. A, *Space-group symmetry*, 5th ed. (2002), ed. T. Hahn;
  Vol. B, *Reciprocal space*, 3rd ed. (2008), ed. U. Shmueli (§1.1 lattices, §1.2 structure factors, §1.4 symmetry
  in reciprocal space); Vol. C, *Mathematical, physical and chemical tables*, 3rd ed. (2004), ed. E. Prince
  (§6.2 Lorentz and polarization factors).
- Thompson, P., Cox, D. E. & Hastings, J. B. (1987). Rietveld refinement of Debye–Scherrer synchrotron X-ray data from
  Al₂O₃. *J. Appl. Cryst.* 20, 79–83.
- Trueblood, K. N. et al. (1996). Atomic displacement parameter nomenclature. *Acta Cryst.* A52, 770–781.
- Warren, B. E. (1969). *X-ray Diffraction*, ch. 4. Reading, MA: Addison-Wesley.

Scattering data and constants

- Sears, V. F. (1989). *Neutron Optics*. Oxford University Press.
- Sears, V. F. (1992). Neutron scattering lengths and cross sections. *Neutron News* 3(3), 26–37.
- Squires, G. L. (2012). *Introduction to the Theory of Thermal Neutron Scattering*, 3rd ed. Cambridge University
  Press.
- Tiesinga, E., Mohr, P. J., Newell, D. B. & Taylor, B. N. (2021). CODATA recommended values of the fundamental
  physical constants: 2018. *Rev. Mod. Phys.* 93, 025010.
- Waasmaier, D. & Kirfel, A. (1995). New analytical scattering-factor functions for free atoms and ions.
  *Acta Cryst.* A51, 416–431.

Time of flight, resolution and instruments

- Forsyth, J. B. (1988). Single crystal pulsed neutron diffraction. In *Chemical Crystallography with Pulsed Neutrons
  and Synchrotron X-rays*, eds. M. A. Carrondo & G. A. Jeffrey, pp. 117–135. Dordrecht: Springer Netherlands.
- Huq, A. et al. (2019). POWGEN: rebuild of a third-generation powder diffractometer at the Spallation
  Neutron Source. *J. Appl. Cryst.* 52, 1189–1201.
- Ikeda, S. & Carpenter, J. M. (1985). Wide-energy-range, high-resolution measurements of neutron pulse shapes of
  polyethylene moderators. *Nucl. Instrum. Methods* A239, 536–544.
- Jorgensen, J. D. & Rotella, F. J. (1982). High-resolution time-of-flight powder diffractometer at the ZING-P′
  facility. *J. Appl. Cryst.* 15, 27–34.
- Carlile, C. J., Taylor, A. D. & Williams, W. G. (1985). MARS: a multi-angle rotor spectrometer for the SNS.
  Rutherford Appleton Laboratory report RAL-85-052.
- Perring, T. G. (1991). High energy magnetic excitations in hexagonal cobalt. PhD thesis, University of Cambridge
  (RALT-028-94).
- Perring, T. G. (1993). The resolution function of the chopper spectrometer HET at ISIS. Proceedings of ICANS XII,
  report RAL-94-025.
  (These three are the references of PyChop's Chop.py, which implements the CHOP model.)
- Stoica, A. D. (1975). On the resolution of slow-neutron spectrometers. II. The resolution function for
  time-of-flight diffractometry. *Acta Cryst.* A31, 193–196.
  (Forsyth and Stoica are the references garnet-tools gives for its model, resolution.py.)
- Von Dreele, R. B., Jorgensen, J. D. & Windsor, C. G. (1982). Rietveld refinement with spallation neutron powder
  diffraction data. *J. Appl. Cryst.* 15, 581–589.

Experiment planning

- Chvátal, V. (1979). A greedy heuristic for the set-covering problem. *Math. Oper. Res.* 4, 233–235.
- Johnson, D. S. (1974). Approximation algorithms for combinatorial problems. *J. Comput. Syst. Sci.* 9, 256–278.
- Lovász, L. (1975). On the ratio of optimal integral and fractional covers. *Discrete Math.* 13, 383–390.
- Nemhauser, G. L., Wolsey, L. A. & Fisher, M. L. (1978). An analysis of approximations for maximizing submodular set
  functions—I. *Math. Program.* 14, 265–294.

Software (pinned commits in `data-sources/sources.json`)

- Arnold, O. et al. (2014). Mantid—Data analysis and visualization package for neutron scattering and μSR
  experiments. *Nucl. Instrum. Methods* A764, 156–166. Sources at commit `67c2f43` (instrument definitions,
  `Unit.cpp`, `UnitCell.cpp`, `Goniometer.cpp`, `Peak.cpp`, ISAW I/O, PyChop).
- Toby, B. H. & Von Dreele, R. B. (2013). GSAS-II: the genesis of a modern open-source all purpose crystallography
  software package. *J. Appl. Cryst.* 46, 544–549.
- Wojdyr, M. (2022). GEMMI: a library for structural biology. *J. Open Source Softw.* 7(73), 4200. Version 0.7.3 for
  space groups, absences and structure factors.
- ORNL garnet-tools `4eb3206` (Q-resolution model) and NeuXtalViz `655afa3` (coverage planner).

## 13. Changes from the 2026-10-06 audit

A code review on 2026-10-06 re-derived the formulas against the literature and the pinned upstream code, with numerical
checks; it is not the domain-expert review the research release still awaits (PLAN §12). Most formulas were confirmed as
written. These were corrected, each with a test that fails on the code before the change:

- **Focused banks** (§10): intensities carried a spurious ⟨sin θ⟩(d) factor (the vanadium's dλ/dd = 2 sin θ was
  missed). Now Σ|F|²·d⁴·sin θ_f. On POWGEN's all-panel bank the old factor varied 16-fold across d.
- **TOF patterns on a Q axis** (§7b): line heights were off by d² (a Jacobian applied to a ratio). Now relabelled.
- **Exact coverage** (§10): one tolerance in every direction made one-axis tracks (TOPAZ cryogenic, CORELLI) miss
  30–80 % of the pixels they cross at low angles. Now per-direction, from each pixel's extent.
- **MDNorm limits** (§10): written in crystallographic hkl, which Mantid's default convention labels −hkl. Now
  written for the convention chosen.
- **Symmetry** (§3, §4): a reverse-setting R operation list was given a second centring; near-coincident atom images
  were merged in an order-dependent way. Both fixed.
- **Smaller:** the CW Lorentz factor at exact backscattering; the planner's nearest-panel test with overlapping
  panels; the outgoing-angle term of the chopper-spectrometer Q estimate (shrunk by cos ν); the axis of a 180°
  rotation (display); IDF parser defaults, now Mantid's (no change to the shipped geometry).
- **Tests strengthened** (they pass on the old code too): every complex b, isotopes included, gets a positive
  imaginary amplitude; the printed b gives exactly I(−h).
- **Claims removed:** "PyChop is within about 10 % of ORNL's vanadium widths", which had no source in the repository;
  what is sourced is that its ARCS and SEQUOIA parameters were tuned to ORNL vanadium data (Mantid PR #38591).
- **Claims narrowed:** the planner's (1 − 1/e) and ln n + 1 guarantees hold for the first goal only, as now stated;
  pixel numbering is ISAW's (Mantid's Row/Col are 0-based); the detector map is equirectangular, not Mantid's
  equal-area view.
