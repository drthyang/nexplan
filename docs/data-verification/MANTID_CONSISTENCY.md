# Consistency with Mantid

NEXPLAN's diffraction geometry is meant to agree with Mantid, the reduction software at SNS. This report lists
each convention and formula the app shares with Mantid, the Mantid source it was compared with, and the test that
pins the agreement. All Mantid sources are at commit
[`67c2f43`](https://github.com/mantidproject/mantid/tree/67c2f43ef79ea4ce4f3c92f417f5c74f8fedcf30), the commit the
instrument definitions are pinned to. The transcription tests are in `src/core/mantid.test.ts`.

| Quantity | NEXPLAN | Mantid source | Agreement |
| --- | --- | --- | --- |
| m_n/h (TOF ↔ d, TOF ↔ λ) | 252.778413 µs/(m·Å), CODATA 2018 | `Kernel/src/Unit.cpp:553`, constants from `PhysicalConstants.h:29,39` (CODATA 2006) | 8·10⁻⁹ relative |
| h²/2m_n (E ↔ λ) | 81.80421 meV·Å² | `Unit.cpp:311, 437–439`, `PhysicalConstants.h:51` | 1·10⁻⁷ relative |
| DIFC and TOF = DIFC·d (+ DIFA·d² + TZERO) | (m_n/h)(L1 + L2)·2 sin θ | `Unit.cpp:579–602` (`tofToDSpacingFactor`), `670–677` (`dSpacing::singleToTOF`) | same formula; constants as above |
| TOF of a wavelength | (m_n/h)·L·λ | `Unit.cpp:355–357` (`Wavelength::init`) | same formula |
| B matrix | Busing–Levy, no 2π | `Geometry/src/Crystal/UnitCell.cpp:820–828` | element by element, 1e-12 (triclinic cell) |
| Q from hkl | q = UB·h (1/Å) | `Geometry/src/Crystal/OrientedLattice.cpp:176`: Q = 2π·UB·h | q = Q/2π |
| Goniometer | R = R₀·R₁·…, counter-clockwise positive; Universal ω(y), χ(z), φ(y) | `Geometry/src/Instrument/Goniometer.cpp` `recalculateR` (quaternion product in axis order), `makeUniversalGoniometer` (298–302); `Goniometer.h:32–34` (CCW = +1) | 1e-12, all SNS goniometers in the catalog |
| Wavelength and k_f of a reflection | λ = −2q_z/\|q\|², k_f = q + ẑ/λ | `DataObjects/src/Peak.cpp` `setQLabFrame`: 1/λ′ = \|Q\|²/(2·Q_beam), Q_beam = qSign·Q·ẑ | 1e-12; Crystallography convention gives +h, Inelastic (Mantid's default) labels the same peak −h |
| Neutron scattering lengths | Sears (1992) via NIST | `Kernel/src/NeutronAtom.cpp`, all 370 rows | see [NEUTRON_SEARS1992](NEUTRON_SEARS1992.md): ¹⁷⁵Lu and ¹⁷⁶Lu differ in Mantid's transcription |
| Detector geometry | flattened from the Mantid IDFs | `instrument/*_Definition*.xml`; `Geometry/src/Instrument/InstrumentDefinitionParser.cpp` | IDF reader semantics in `scripts/data/idf.ts`, defaults as the parser's (rotation axis components, `idstepbyrow`) |
| Pixel column and row | ISAW: col = (x/w + ½)·n + ½, centres at 1 … n | `SaveIsawPeaks.cpp:367-369`, `Peak.cpp:255-260`, `RectangularDetector::getXYForDetectorID` | Mantid's Peak Row/Col of a rectangular detector are 0-based: round(col) − 1 |
| Sign of hkl | crystallographic, q = k_f − k_i = UB·h | `LoadIsawUB.cpp:129-159`, `SaveIsawUB.cpp:126-136` (UB's sign kept); `LoadIsawPeaks.cpp:427-432`, `SaveIsawPeaks.cpp:292-294` (hkl × qSign) | under Q.convention = Inelastic (the default) Mantid labels the same peak −hkl; the MDNorm limits are mirrored for it |
| Detector map | γ = atan2(u_x, u_z), ν = asin(u_y), plotted equirectangularly | `MantidWidgets/InstrumentView/UnwrappedCylinder.cpp`, `RotationSurface.cpp` | Mantid's cylindrical view is equal-area (sin ν upwards); cos 2θ = cos γ·cos ν either way |

## End-to-end checks against Mantid output

`src/core/instrument/detectors.test.ts` and `src/core/ub/topaz.test.ts` use a TOPAZ run reduced by Mantid (the
`TOPAZ_3007` peaks file and its ISAW UB, from Mantid's test data):

- The panel centres the app builds from the IDF reproduce the geometry Mantid wrote into the peaks file to 0.01 mm.
- Every observed peak lands on its recorded detector, column and row within 0.1 pixel.
- From the UB and the goniometer angles, the app predicts each peak's detector, and its pixel within the UB fit's
  angular residual.
- Indexing, UB⁻¹·Rᵀ·(k_f − k_i), gives the +hkl of the file.

## Where NEXPLAN goes beyond Mantid

Mantid does not simulate powder intensities. The TOF powder line intensity Σ|F|²·d⁴·sin θ per unit solid angle is
GSAS-II's Lorentz factor (see CONVENTIONS §7b and §10). Focused banks follow what Mantid's focusing does, with the
standard groupings (see the instrument catalog for sources): pixels summed in d, divided by vanadium, then put on
the bank's DIFC from its effective L2 and 2θ.
