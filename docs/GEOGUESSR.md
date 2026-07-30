# GEOGUESSR.md — geolocation technique reference

Working reference for pinpointing a location from a single image. Compiled into the LOCATE and INTERIOR prompts; also the manual checklist an analyst uses to verify a result.

**Read this first:** the goal is *discrete, individually checkable observations*, not a guess. Every line below exists so the model can say "I see X, which implies Y, here is the crop" — and a human can then check X themselves. A confident answer with no citable observation is the failure mode this document exists to prevent.

Items marked **UNVERIFIED** could not be confirmed against a primary source. Do not present them as evidence.

---

## 1. The decision tree

Experts do not guess a country and refine. They resolve scale in order, and each step uses a different class of signal.

| Step | Decisive signals | Cost |
|---|---|---|
| **Hemisphere** | Shadow direction at solar noon; vegetation season vs. claimed date; sun path arc | Free, glance |
| **Continent / bloc** | Script, driving side, plug type (indoors), road-marking colour, vehicle fleet | Free, glance |
| **Country** | Bollards, utility poles, signage typography and backing plates, plate dimensions, phone/TLD formats, outlet type | Cheap, decisive |
| **Region / state** | Route-shield design, plate colour scheme, soil colour, vegetation association, guardrail and delineator hardware, regional retail chains | Moderate |
| **City / district** | Architectural vernacular, street furniture, transit livery, topography, named businesses | Moderate |
| **Street / address** | **Retrieval against indexed street imagery, or OCR of a legible sign then geocode. Nothing else.** | Expensive |

**The load-bearing fact: street-level precision cannot be inferred.** On GWS15k — the only benchmark that samples by land area rather than by tourist-photo density — the best published 1 km accuracy is **0.7%**. The 14–24% "street-level" figures quoted elsewhere come from Flickr landmark photos. When Lantage returns a street, it is because a panorama matched or a sign was read, and the evidence chain says which. This is enforced in code by `assertStreetPrecisionIsEarned`.

**Most images resolve to region.** That is a useful answer. Design the output around it.

---

## 2. Outdoor signal catalogue

### 2.1 Driving side and road markings
Driving side is the cheapest continental split. Then:
- **Centre line colour**: yellow separates opposing directions in North America; white does so in most of Europe, Asia and Australia. A **yellow centre line is a strong Americas signal.**
- **Edge lines**: white both edges in North America; in Europe the shoulder line style varies by country.
- Crosswalk style (zebra vs. ladder vs. continental block), stop-line placement, and dashed-line length-to-gap ratio are all national conventions.

### 2.2 Delineators — the most useful US state-level object
Roadside delineator posts are near-uniquely diagnostic at state level because each DOT specifies its own plate shape and colour, and they appear in almost every roadside frame.

Federal baseline (MUTCD 11th ed., ch. 3G): colour matches the adjacent edge line — **white on the right edge, yellow on the left edge of a *divided* roadway**, but §3G.03.06 makes the left side of a *two-way* roadway white, so yellow-left implies a divided highway. **Red** appears on the reverse face where a wrong-way driver would see it. Mounting ~4 ft, constant offset 2–8 ft outside the shoulder, spaced 200–530 ft on tangents. Anything markedly taller or irregularly spaced is a **snow stake, not a delineator.**

State designs (readings of state-labelled street imagery; treat as strong priors, not proof):

| State | Delineator |
|---|---|
| Missouri | **Double-lobed / "peanut-shaped" white plate** — the most distinctive in the country |
| Vermont | White flexible pole with a **vertical column of reflective graduations** (a snow-measuring stake) |
| Michigan | Perforated flat post, **green rectangle bearing two white dots** |
| New York | White/grey **flat blade with a single black horizontal stripe** |
| Wisconsin | White post, **dark blue/black rectangle** |
| South Carolina | **Wooden round post with the top foot painted yellow** |
| Washington | **Brown** flat post, vertical amber rectangle |
| Maryland | White round tube with a **yellow band** |
| Maine | White/grey post, **green band** plus black cap |
| Massachusetts | Perforated flat post, **red rectangle** at top |
| Connecticut | Thin perforated galvanized rod, small **red plate at the very top** |
| Indiana / Kentucky / Pennsylvania | Tall all-**yellow** flexible post (KY has a black cap; PA rounded top) |
| Florida / Iowa | Galvanized round pipe, **amber** rectangle |
| Utah | Black post, **alternating yellow/black checker** bands |
| Colorado | Tall dark-green post, **one or two white diamonds stacked** |
| Mississippi | Flat post, **two white diamonds stacked** |
| Nebraska | Dark post, **two orange rounds stacked** |
| Alaska | Very tall slender **salmon/pink** flexible poles, two orange squares near top |
| North Dakota | Tall **bright orange** flexible poles at guardrail ends |

**Negative evidence matters as much:** a bare white diamond or white circle is shared across a large set (CO, GA, IL, IA, NE, NM, OK, WI, WY and others) and is never decisive alone.

### 2.3 Guardrail and barrier
- **W-beam**: the **Midwest Guardrail System places rail splices at mid-span rather than at posts** — a direct visible marker of newer installations.
- **Box-beam** (square hollow section): New York has its own catalogued hardware ("Box-Beam Terminal, NYSDOT Type IIA"); also Wyoming. Painted box beam occurs in NY, so don't assume galvanized. Specified where deflection room is limited — bridge approaches, sharp curves, high fills.
- **Weathering (rusty) steel rail** skews New England. **New Hampshire stopped specifying it** after a 2009 NHDOT survey found 25% midspan and 50–71% connection failure in 10–20-year-old rail, so rusty rail in NH *dates* the installation. Maine has ASTM A588 rail in service. Detection tip: weathering steel **bleeds rust stains onto the pavement below it.**
- **Connecticut's Merritt Parkway aesthetic guardrail** — 6"×12" wood beams backed by steel plates on weathering-steel posts at 10 ft centres — is the most distinctive state-branded barrier in the US.
- **Cable median barrier**: documented heavy use in Minnesota (posts **slide into buried sleeves**, so look for stubby ground-level sleeves), Texas (~335 mi by 2007), Ohio, North Carolina, Washington. High-tension and low-tension are visually indistinguishable.
- **Concrete barrier height**: FHWA standard is 32 in; **New York, Massachusetts and New Jersey adopted taller.** Ontario's **Tall Wall is 42 in** — a US/Canada discriminator on 400-series highways.
- **Object markers** (MUTCD ch. 2C): Type 3 is a **12×36 in vertical rectangle with black and yellow 45° stripes sloping down toward the side traffic passes** — the stripe direction tells you which side the lane is on. Type 4 with nine **red** reflectors means end of roadway.

### 2.4 Utility poles
- **Material**: wood dominates North America (**southern yellow pine** most used); spacing ~125 ft urban, ~300 ft rural. Concrete is common in marine/salt-fog environments. Steel tube is typically 11-gauge galvanized.
- **The concrete-pole tell**: concrete cannot be drilled after installation, so **all hardware is banded or strapped on.** Banded hardware with no through-bolts identifies a concrete pole at distance.
- **Pole branding** sits just below eye level and encodes manufacturer, height, ANSI class, species (SP = southern pine, WC = western cedar, DF = Douglas fir), preservative (C = creosote, P = penta, SK = CCA) and a two-digit year. Older poles carry **date nails**.
- **Painted bands are regional**: Hawaii uses thick **yellow bands** (and yellow signposts generally); California uses **three yellow stripes**. Don't confuse them.
- **UNVERIFIED**: crossarm-vs-armless split by US region; underground-vs-overhead share by state; guy-wire marker patterns; transformer cluster-mount distribution; Florida concrete-pole dominance; Hawaii pole material.

### 2.5 Route shields and signage
- **Pennsylvania**: state routes use a **keystone outline — white keystone on a black square** (MUTCD M1-5, 24×24 in), no state name in the modern design. Distinctive against the plain white shapes most states use.
- **Hawaii**: shields shaped like a **"guitar pick"** with numerals at the bottom.
- Shape, backing plate presence, font (FHWA Series vs. Clearview), and route-shield geometry are all state-level signals.
- **Pennsylvania's small white reference markers** are a genuinely PA-specific roadside object: four-digit State Route numbers aren't signed on the road, so they appear on small white markers near intersections and bridges, on half-mile segments numbered in multiples of 10.
- **Keystone Markers** — **cast iron, keystone-shaped, light blue with gold lettering**, giving town name, name origin, founding date and distance to the next town. Created just after WWI; ~600 survive. Seeing one is effectively conclusive for Pennsylvania.
- **Allegheny County Belt System** — six concentric colour-named belts (Red, Orange, Yellow, Green, Blue, Purple), 280.5 mi, shields **spelling the colour name out**. On ordinary residential surface streets, not ring roads. "YELLOW BELT" on a sign is effectively conclusive for Allegheny County.

### 2.6 Licence plates — **style and jurisdiction only**
Read dimensions, colour scheme, mounting, and **whether a front plate is present**. Never read, log, or persist plate characters: Lantage ships no ALPR, private plate reading is outright illegal in New Hampshire and Maine, and our imagery source contractually forbids un-blurring plates.

- **Pennsylvania has required a rear plate only since 1952** — no front plate on a PA car, visible from any frontal view.
- PA base designs, useful for dating: blue-on-yellow with a large keystone separator (1977–91); dark blue on white with navy top band and yellow bottom band plus **visitPA.com** (2004–2025); **cream with a Liberty Bell and red "Let Freedom Ring"** (May 2025–present).
- Roughly 19 US states require only a rear plate; that alone halves the candidate set from a frontal view.

### 2.7 Vegetation, soil and terrain
- **Biome and dominant species** narrow to a latitude band and continent. Cross-reference a Köppen or WWF ecoregion raster rather than trusting the model's biome claim alone.
- **Soil colour is a real discriminator.** Verified from USDA Official Series Descriptions: **Gilpin** (dominant Western PA plateau upland, 6M+ acres) is **yellowish-brown 10YR 5/4–5/6, channery silt loam full of flat platy shale fragments**, shallow to bedrock. **Hagerstown** (limestone valleys of eastern/south-central PA) is **yellowish-red to red, 5YR 4/6 to 2.5YR 4/6, clay-rich and deep.** So: **red plowed fields = eastern/limestone PA; yellowish-brown shaly soil = Western PA plateau.**
- Agricultural pattern (field shape, terracing, irrigation type) is a strong regional signal.
- **Pennsylvania is ~60% forested**; state tree **eastern hemlock** occupies rocky ridges and moist ravines, so dark hemlock on north-facing ravine walls amid deciduous hillside is an Appalachian signature. NW PA's Allegheny hardwood forest is post-logging second growth dominated by **black cherry and maple**, with an unusually uniform 70–100-year age structure.

### 2.8 Text conventions
- **Phone number format** (grouping, leading zero, country-specific lengths) and **domain TLD** on any visible signage are near-conclusive when legible.
- **Address format** and street-name conventions (numbered grid vs. named, "Street/Avenue" vs. local equivalents).
- **Script family** narrows immediately; specific diacritics pin a language (e.g. ă/ș/ț for Romanian, ő/ű for Hungarian).

### 2.9 Sun and shadow — a verifier, never a solver
Solar position is a function of (latitude, longitude, date, UTC time). Knowing azimuth *and* elevation gives two constraints on four unknowns.

| You have | You get |
|---|---|
| Shadow ratio + **exact timestamp** | A **band** of possible latitudes — one strong constraint |
| Shadow ratio, **no timestamp** | **Nothing usable** — latitude, date and time are jointly underdetermined |
| Shadow *direction* only | Hemisphere; rough time of day |
| Candidate location + timestamp | **Strong verification** — reject candidates whose predicted shadow contradicts the image |

Tooling: **Bellingcat's ShadowFinder** (MIT licensed, on PyPI) takes object height and shadow length in any consistent unit — pixels work — plus date and UTC time, and returns a band of possible locations. Bellingcat's own framing is that this is a hypothesis-testing tool, not a standalone solver. Use it to re-rank candidates; never to seed a search.

### 2.10 Street-View-specific artefacts
Camera generation, rig shadow, blur signature, and seasonal/resolution cues apply **only to Street View imagery**, not to arbitrary user photos. Useful when the query image is itself a Street View screenshot — which is exactly how this tool will most often be tested.

---

## 3. Indoor signal catalogue

Indoor photos have no landmarks, no sky and no street furniture. They are resolvable to **country** surprisingly often and to **building** almost never — unless the image was published somewhere, or there is a view through a window.

### 3.1 Electrical outlets — the single strongest indoor signal
~15 mutually exclusive families, near-immutable per country, and almost always in frame.

| Type | Appearance | Region |
|---|---|---|
| **A** | 2 flat parallel blades, no earth | US, Canada, Mexico, **Japan**; also China, Taiwan, Thailand, Philippines, Vietnam alongside others |
| **B** | Type A plus a round/D-shaped earth pin | "By far the most common receptacle in North America" |
| **C** | 2 round pins, unearthed, unpolarised (Europlug) | Flush unearthed 2-round-hole sockets are illegal in new work almost everywhere ⇒ old or informal install, not a country |
| **E** | Round recess, 2 holes, **plus a male earth pin projecting out of the socket** | **France, Belgium, Poland, Czechia, Slovakia.** The protruding pin is the easiest European discriminator |
| **F** | Schuko — circular recess, 2 round apertures, **earthing clips on the sides**, unpolarised | Germany, Netherlands, Spain, Sweden, Norway, Finland, Russia, Indonesia, **South Korea** |
| **G** | 3 **rectangular** pins, isosceles triangle, fused plug | UK, Ireland, Cyprus, Malta, Hong Kong, Singapore, Malaysia, Arabian Peninsula, much of Africa/Caribbean |
| **H** | 3 pins in a **Y/splayed** arrangement (flat pre-1989, round after) | Israel / Palestine — essentially unique |
| **I** | 2 flat pins in an **inverted V** plus vertical earth | Australia/NZ. **China GB 1002 is near-identical but conventionally mounted upside down** (earth uppermost) — that inversion is the reliable test. Argentina reverses live/neutral |
| **J** | 3 round pins, earth offset only 5 mm | Switzerland, Liechtenstein |
| **K** | 2 round pins plus **U/D-shaped earth pin** below | Denmark, Greenland, Faroes. **A *switched* round-format socket ⇒ Denmark, not the UK** |
| **L** | 3 round pins **in a straight line**, earth centre | **Italy**, Chile, Uruguay. 10 A and 16 A variants are mutually incompatible — an Italian wall often carries both |
| **M** | 3 **large** round pins, oversized earth on top | South Africa, Eswatini, Lesotho; also India/Nepal/Israel/UAE for heavy appliances |
| **N** | 2 round pins plus earth offset 3 mm, hexagonal, shuttered | Brazil, South Africa |
| **O** | 3 round pins, earth offset 11.9 mm | Thailand only |
| **D** | 3 round pins in a triangle, uninsulated | India, Nepal, with M alongside for large appliances |

**Dating and sub-national cues:**
- **Ungrounded 2-slot US receptacles have been prohibited in new construction since 1962** ⇒ pre-1962 or un-upgraded wiring.
- **Tamper-resistant (shuttered) US receptacles required by NEC since 2008** ⇒ visible internal shutters mean post-2008 build or renovation.
- **NEMA 5-20R has a T-shaped neutral slot** ⇒ 20 A circuit, typical of US kitchens, bathrooms, commercial fit-outs.
- **Schuko shutter test**: German DIN does **not** require socket shutters, but Portugal, Finland, Denmark, Norway, Sweden and Italy do — obvious shutters argue *against* Germany.
- **Voltage disambiguates the flat-blade families**: flat blades + **100 V ⇒ Japan alone**; + 120 V/60 Hz ⇒ US/Canada/Mexico; + **220–230 V ⇒ Asia** (China, Philippines, Thailand, Vietnam) — the classic trap. **Schuko + 60 Hz ⇒ South Korea.** **Type G + 60 Hz ⇒ Saudi Arabia** vs UAE at 50 Hz.
- **UK bathrooms**: BS 4573 two-pin shaver socket, ceiling pull-cord switches, and generally **no standard sockets** — a strong signature.

### 3.2 Light switches
- **US/Canada**: **toggle** predominates; the flat broad paddle is "Decora" (a genericized Leviton trademark).
- **Europe, Brazil, Hong Kong, Malaysia, Singapore, India**: rockers are near-universal, often full plate width.
- **Australia/NZ**: small 16 mm rocker mechanisms — which is why AU/NZ plates carry three or four switches where a US plate fits one or two.
- **"On" is UP**: US, Canada, Finland. **"On" is DOWN**: UK, Ireland, Europe generally, India, Australia, NZ, Egypt, China.
- **Box geometry shows through the plate**: **UK BS 4662 86×86 mm square plate with two visible screws at 60.3 mm centres**; **Europe round flush boxes 68 mm diameter at 71 mm centres**; **Italy rectangular boxes with modular inserts** at ~22 mm horizontal pitch. **Surface mounting is standard in North America but uncommon in Europe.**
- Brand origin (supporting evidence only): **Legrand** French (owns Bticino Italy, Pass & Seymour NA); **Clipsal** Australian (Schneider since 2004); **MK Electric** British (invented the first shuttered socket, 1928).

### 3.3 Heating and HVAC
| Visible object | Reads as |
|---|---|
| Welded-steel **panel radiator** under a window with a numbered valve head | UK + continental Europe |
| **TRV** with a dial marked 1–5 plus a **snowflake** frost setting (Danfoss, Caleffi) | Continental Europe strongly |
| **Fin-tube hydronic baseboard** at floor level | "the modern North American standard" |
| **Floor/wall/ceiling ducted registers and grilles** | North American forced-air furnace |
| **Wall-mounted horizontal indoor head** ~1 m wide, high on the wall | Ductless mini-split — Japan-origin (Mitsubishi, 1968); dominant Japan/Korea/China/SE Asia, expanding to Middle East, Latin America, **Southern Europe** |
| **Window/through-wall AC box** | North America residential; Latin America and Middle East retrofits |
| **Kotatsu** — low table frame with a futon draped over it | Japan (~81% of homes by 1997) |
| **Kerosene heater**, esp. rectangular fan-forced with a side cartridge tank | **Primary home heat in Japan**; supplemental only in US/Australia |
| **Cast-iron column radiator** | Older UK/US stock |
| No boiler, just a heat-exchanger substation | District heating — Nordics, Eastern Europe, Russia |

AC penetration priors: US ~87% of households; Italy ~50%, Spain ~40%, **France 20–25%** — so a mini-split in a European room shifts probability strongly south.

### 3.4 Windows, shutters, doors
- **Tilt-and-turn** (single lever on the sash edge, no crank): most common type in **Germany**, widespread in Europe. Europe operates "turn first," UK "tilt first."
- **Double-hung sash** with a six-over-six glazing pattern: UK origin 1670s; "hung sash" terminology is more American than British. Traditional counterweight-and-pulley vs modern spring balances.
- **Jalousie/louvre** windows: "used extensively in tropical architecture."
- **Rollladen** — rolling shutters that **roll up into a box concealed in the wall above the window**. Indoors this shows as a **horizontal box or lintel recess above the window plus a strap, crank or tape drive on the reveal** — one of the most reliable Germanic/Continental interior cues. Common in Italy, Germany, France, Spain.
- **Storm windows are "common in North America but uncommon in continental Europe"** — especially the US Northeast/Midwest and Canada, classically triple-track aluminium. A clean NA ⇔ Europe discriminator.
- **Euro profile cylinder** (flat figure-of-eight escutcheon, swappable without altering boltwork) ⇒ Europe/UK family; **round key-in-knob plus separate deadbolt** ⇒ North America.
- **Japan**: *genkan* recessed entry with a 5–10 cm floor drop and shoe cupboard; *shōji* sliding translucent panels on a kumiko lattice in wooden grooves; **tatami**, whose regional sizes discriminate *within* Japan — Kyōma (Kyoto) 1.91×0.955 m, Chūkyōma (Nagoya) 1.82×0.91 m, Edoma (Tokyo) 1.76×0.88 m. Grid (+ shaped) mat junctions are inauspicious, so a grid layout is anomalous.
- **Letterboxes**: UK/Ireland door slot ~30×5 cm through the door; continental EN 13724 requires a C4 envelope, mounted 0.7–1.7 m; US curbside **Joroleman** box with a rotating **red flag**.
- **UNVERIFIED**: lever-vs-knob national mapping; insect-screen distribution; burglar-bar distribution; outward-vs-inward casement by country; socket mounting heights.

### 3.5 Ceilings, trim, flooring
- **Popcorn / acoustic ceiling** (vermiculite or polystyrene, random bumpy): North American. Popularity fell after the mid-2000s; asbestos formulations persisted into the 1980s despite a 1963 US ban, so it also brackets a date.
- **Artex** (British analogue, **swirled and stippled patterns**): popular in Britain in the 1970s; contained chrysotile until 1984. **Swirl/stipple = UK/Ireland; random "cottage cheese" = North America.**
- **Suspended ceiling grid pitch is a metric/imperial fingerprint**: North America 2×2 ft (610 mm) or 2×4 ft; **Europe 600×600 mm grid with 595×595 mm tiles.**
- Terminology in any caption is itself a cue: **baseboard** (US) vs **skirting board** (UK/Australia). North American practice adds a **shoe/quarter-round** at the floor line.

### 3.6 Text, packaging and paper — cheap confirmations
- **Paper size**: **A4 = 210×297 mm (ratio 1:1.414); US Letter = 216×279 mm (1:1.294).** A4 is narrower and taller — measurable off any document, notice board or printer tray. Letter persists in US, Canada, Mexico, Costa Rica, Colombia, Venezuela, Chile, Philippines.
- **Date format**: **MDY ⇒ United States** (and the Philippines numerically). **YMD national standard ⇒ China, Japan, Korea, Taiwan, Hungary, Lithuania, Mongolia, Bhutan.** DMY ⇒ most of Europe, Africa, South America, much of Asia. **Dot separators (24.12.2026) ⇒ German-speaking.**
- **Nutrition labels**: US per-serving with a **%DV column**; **EU/UK mandatory per 100 g with energy in both kJ and kcal**; **UK front-of-pack traffic lights** for fat/saturates/sugars/salt; **Nutri-Score A–E** argues France/Benelux/Germany/Switzerland/Spain and **argues against Italy** (which opposes it); **Chile/Mexico black octagon warnings**; **Australia/NZ dual-column NIP plus Health Star Rating**.
- **Barcode GS1 prefix** — **critical caveat, stated by GS1 itself: the prefix identifies the issuing member organisation, NOT the country of origin.** Still a useful weak prior. Examples: 000–139 US · 300–379 France · 400–440 Germany · 450–459 & 490–499 Japan · 500–509 UK · 690–699 China · 754–755 Canada · 800–839 Italy · 840–849 Spain · 880–881 South Korea · 890 India · 930–939 Australia.
- **Lamp caps**: "Exx" is the diameter in mm. **E26 = North America and Japan/Taiwan; E27 = Europe.** **B22d bayonet (two side pins, no thread) = UK and much of the former British Empire** — Canada, US and Mexico use Edison screw. A bare bulb base is a free country signal.
- **Measurement units**: UK is a distinctive *mixed* regime — metric primary on packaging with imperial permitted only in smaller characters, imperial-only for draught beer and road distances, body weight culturally in stones. A shelf label showing both £/kg and £/lb reads UK; purely oz/fl oz/°F reads US.

### 3.7 Exit signs, extinguishers, detectors — very high value when present
- **EU/international**: **ISO 7010 green "running man"** pictogram, per Directive 92/58/EEC.
- **US**: **red or green permitted, red traditional**; NFPA 101 requires **textual "EXIT"** for standard mounting. Jurisdiction mandates: green in Baltimore, Salt Lake City, Portland; **red in New York City, Rhode Island, Chicago.** A **red word "EXIT" is a strong US cue.**
- **Canada**: the 2010 Code mandates the **green ISO running man**, so new/renovated Canadian buildings show the pictogram while older stock retains red.
- **Japan**: green lettering with a white running-man pictogram (Yukio Ota, 1979).
- **Fire extinguishers**: **UK/EU BS EN 3 — red body with a colour band (cream = foam, blue = dry powder, black = CO₂, yellow = wet chemical); before 1997 the whole body was colour-coded**, so an all-blue body is pre-1997 stock. **US NFPA 10 has no colour mandate**; identification is by class letter — and **the letter set is diagnostic: "K" for cooking oils = US, "F" = Europe/Australia.**
- **Smoke detectors**: typical disc ~125 mm diameter. US NFPA 72 requires hardwired-plus-battery interconnection in new construction; **Queensland mandates interconnected mains photoelectric detectors** in new dwellings from 2017 and all dwellings by 2027.

### 3.8 Bathroom and appliances
- **Bowl hydraulics**: **siphonic with a large water surface is "perhaps the most popular design in North America"**; **washdown with a small water spot is "the most common form outside the Americas."** **A small water spot ⇒ non-American.**
- **Shelf / washout toilets** (flat platform with a shallow pool): **Austria, Czechia, Germany, Hungary, Netherlands, parts of Poland** — highly diagnostic Central European.
- **Bidets**: **mandatory in Italian and Portuguese bathrooms since 1975**; French household prevalence fell from 95% in the 1970s to 42% by 1993; **Japan ~76% electronic bidet seats (2015)**; **bidet showers standard across the Islamic world, South Asia, and also Finland**; **rare in UK, US, Germany.**
- **Washing machine location is a European signature**: Europe uses ~600 mm front-loaders installed under a counter **in the kitchen or bathroom**; **North America uses top-loaders in a basement or dedicated laundry room** with a separate dryer.
- Brand origin: **Beko** Turkish; **Fisher & Paykel** New Zealand — **a DishDrawer strongly indicates NZ/Australia.**

### 3.9 The window view — the highest-value indoor cue
If any exterior is visible, the problem reduces to ordinary geolocation. Prompt for it separately: skyline, terrain, opposite buildings, vegetation, vehicles, signage. Sun angle through a window constrains facing direction; viewing angle over surrounding rooftops constrains floor height. A published Molfar investigation resolved a subject to a specific building and **floor** from a cat sitting at a window.

---

## 4. US state-level discriminators

A country-level answer is useless to an investigator. These separate US regions.

- **Regional retail is the cleanest single cue.** **Sheetz** (HQ Altoona) is western and central PA plus WV/MD/OH/VA/NC — and was **absent from the Philadelphia area until February 2026.** **Wawa** (HQ Chester Heights) is eastern/Philadelphia-metro PA. **A Sheetz forecourt in PA ⇒ western/central; a Wawa ⇒ eastern.** Analogous chains discriminate elsewhere: H-E-B (Texas), Publix (Southeast), Wegmans (NY/PA), Winco (Northwest), Buc-ee's (Texas and expanding).
- **State liquor retail**: Pennsylvania is a control state — a storefront reading **"Fine Wine & Good Spirits"** is conclusive for PA. PA also has a separate standalone **"Beer Distributor"** warehouse retail tier.
- **Route shield design** (§2.5) and **delineator design** (§2.2).
- **Plate colour scheme and front-plate presence** (§2.6).
- **Soil colour** (§2.7).
- **Snow-region indicators**: snow stakes, roof pitch, storm windows, salt staining, tall driveway markers.
- **Volunteer fire company halls** with social hall and carnival grounds are extremely dense in Pennsylvania (~2,500 departments, mostly volunteer).
- **Municipal fragmentation**: PA's dense borough/township structure means street-blade colour and typeface change every few miles. Treat **inconsistent blade design over short distances** as a PA/NJ/New England fragmentation signal rather than reading one blade as diagnostic.

### 4.1 Pittsburgh and Western Pennsylvania — metro #1

**Conclusive on a single cue:**
- A **belt-route shield with the colour spelled out** ("YELLOW BELT")
- A **funicular** — Monongahela Incline (1870, 635 ft, ~35° grade, oldest continuously operating in the US) or Duquesne Incline (1877, 800 ft, 30°, Second Empire lower station)
- A **lenticular truss** over a brown river — the Smithfield Street Bridge (Lindenthal, 1883), unmistakable double-convex "eye" profile
- The **Three Sisters** in parallel — Clemente/Warhol/Carson, self-anchored eye-bar suspension, "the only trio of nearly identical bridges" in the US
- **Aztec Gold** painted steel over the Allegheny — downtown bridges are painted to match the city's black-and-gold
- A **staircase carrying a street-name blade** — many Pittsburgh steps are legally classified as city streets

**Strong, needs one corroborator:**
- **Buff, blond, grey or white brick** rowhouses. Local Kittanning-district clay produced non-red brick, and "this clay does not exist outside of this immediate vicinity." Expensive Kittanning brick often faced the street only, cheap red brick the sides — so a block reads as a rainbow of brick colours with mismatched red side walls at corners.
- **Insulbrick** (asphalt sheet stamped to imitate brick) or **Perma-Stone** (cast imitation stone) siding, often with **aluminium awnings** — the Rust-Belt working-class Pittsburgh combination.
- **A house whose street door is on its second floor**, with the lot plummeting away — a documented Pittsburgh hillside pattern.
- Hillside frame houses "one room wide, two rooms deep, up to four stories high," balloon-framed into the slope with geometric slate patterns.
- **Double-decked bowstring arches** at the Point — Fort Pitt (1959, world's first computer-designed bowstring) and Fort Duquesne (1969).
- **Squirrel Hill Tunnel portal buildings faced in sandstone and brick with louvered openings and glass-block windows**; Liberty Tunnel's horseshoe bores (1924); **Armstrong Tunnel's bores that bend halfway through.**
- **Steep Belgian-block streets** — Canton Avenue, Beechview, claimed 37% grade on cobblestone.
- Rowhouse metrics: Charles Street district houses are **13 ft wide, 35 ft deep**, two stories plus **mansard** with diagonally-cut shingle bands and gabled dormers, on **cut sandstone foundations**.

**City steps — cite a range, not a number.** 739 sets (Regan's catalog, basis of the 2017 City Steps Plan); "nearly 800" city-owned; 877 in the 2020 city database; **44,645 risers, ~24,100 vertical feet.** Two classes: ~450 built on elevated structures, ~350 built into sidewalks ("jumperwalks"). Densest: **South Side Slopes ~70 sets**, **Fineview 17** (including Rising Main Avenue, 331 steps), **Polish Hill 16**, **Troy Hill 11**. Nearly two-thirds are in low- or moderate-income areas.

**Do NOT over-attribute stairs to Pittsburgh.** Cincinnati has ~400 city-owned sets and historically 30+ miles; Portland OR has ~200. Escalate to Pittsburgh only when stairs combine with a street-name blade, buff brick, or gold steel bridges.

**Also not Pittsburgh-diagnostic:** the "Pittsburgh toilet" (a basement fixture, invisible from outside, and also found in Cleveland, Milwaukee, NJ, NY, Oregon); flounder houses (statewide PA and Philadelphia/Lancaster); gable-front-with-porch (a national working-class type); and the "446 bridges / most in the world" claim — that figure is from a 2006 book counting footbridges and rail spans; the National Bridge Inventory lists **297** public automobile bridges in the city, and **Philadelphia has 591.**

**Terrain.** Pittsburgh sits on the **unglaciated, dissected Allegheny Plateau** — an eroded tableland of chaotic short hills and steep hollows with **no ridge grain**, relief 200–400 ft, elevations 900–1,500 ft. This distinguishes it from: **long straight parallel ridges with flat farmed valleys = central PA Ridge-and-Valley**; **flat lake plain with a sandspit = Erie**; **softer rounder terrain with ≤100 ft relief = glaciated NW PA.** Elevation range in the city is 710–1,370 ft, and over a quarter of the 90 neighbourhood names reference hills or heights.

**Western PA beyond the city:** Mon Valley steel towns (Braddock's Edgar Thomson works with stacks abutting a street grid riddled with vacant lots; population fell 91.8% from ~20,000 in the 1920s to 1,721 in 2020); **coal patch towns** — an isolated double row of identical small frame houses on a narrow valley floor, no street trees, one larger company store; **Marcellus gas infrastructure** — rectangular gravel pads with tank batteries, wide straight pipeline cuts over ridge lines, lined impoundments, cut into second-growth forest; **Laurel Highlands** ridges (Mount Davis, 3,213 ft, the PA high point); **Amish settlements in Crawford (~4,661), Mercer (~2,875), Indiana (~2,708) and Lawrence counties** — so a buggy in PA does **not** imply Lancaster; check terrain and soil.

---

## 5. Confidence and failure modes

**When each signal lies:**
- **Chain retail and big-box stores** look identical continent-wide. A Walmart facade tells you "North America" and nothing more.
- **Transplanted architecture** — colonial vernacular, themed developments, film sets.
- **Imported and grey-market vehicles** break fleet-mix reasoning.
- **Interiors of studios, greenhouses, warehouses and hotel rooms** are often genuinely unsolvable — deliberately generic, no outlets in frame, no window.
- **Model hallucination is the dominant failure.** The ACL 2026 GeoRC study found frontier models "couldn't provide reasoning for their guesses or were vague," with experts identifying "many suspicious or hallucinated attributes." Bellingcat's 500-test evaluation concluded that "the majority of models, at some point, returned a hallucination" and that even the best "still, at times, confidently point[s] to the wrong location." Bellingcat's 2023 test found models failed specifically on **commercial logos, building signage, storefronts, and interior architectural elements** — and invented structures, signs and even non-existent archives.
- **Reverse image search has a coverage bias.** Bellingcat: all engines "struggle with South America, Central America/Caribbean, Africa, and much of Asia." A null result outside Western and former-Soviet regions is weak evidence of anything.
- **Reverse image search finds copies of *your image*, not other photos of *your room*.** TinEye is explicit that it returns exact matches including crops and edits, not similar scenes. If the query is an original frame shot by the subject, every reverse-image API returns nothing, permanently. This is the single most important calibration for the INTERIOR module.

**What makes an image genuinely unsolvable — refuse rather than guess:**
- No text, no infrastructure, no vegetation, no sky, no outlets
- Resolution below the point where any of the above is legible
- Interior with no window, no fixtures in frame, no packaging, no published copy
- Heavily edited, AI-generated, or composited input
- A scene whose only cues are globally uniform (plain wall, plain sky, generic asphalt)

A refusal that names what would make the image solvable is a better product than a plausible wrong answer. See `QualityGate.refusalReason` and `Confidence.band === 'refused'`.

---

## 6. Prompt-ready extraction checklist

Ordered walk for the vision model. Each item maps to a field in `VlmCluesSchema` (`src/lib/contracts/schemas.ts`). Emit **discrete observations with `legibility` and `bbox`**, never a bare guess. Populate `regionPrior` **last**, and only from observations already emitted — a prior whose `supportedBy` cites nothing in the observation list is discarded downstream as a hallucination.

**→ `text[]`** — every legible string, verbatim, with `kind`:
1. Business names, shop signs, awnings
2. Street signs and street-name blades
3. Address numbers
4. Transit signage
5. Phone numbers (format matters as much as digits)
6. Domain names / TLDs
7. Script and language of each string (`script` field)
8. Licence-plate **style and jurisdiction only** — never characters

**→ `infrastructure[]`** — with `impliesRegions`:
9. Driving side
10. Road-marking colour and pattern (centre line, edge lines, crosswalk style)
11. **Delineator** design — colour, plate shape, mounting height, spacing (§2.2)
12. **Guardrail** type — W-beam splice position, box beam, cable, weathering steel, concrete height (§2.3)
13. **Utility poles** — material, banded vs bolted hardware, crossarm style, painted bands, visible branding (§2.4)
14. Bollards, chevrons, snow stakes, object markers
15. Traffic-light form and mounting; curb style; fire hydrant form; manhole covers
16. **Route-shield shape and colour**; sign backing plates; sign typeface

**→ `environment[]`** — with `impliesRegions`:
17. Biome and dominant vegetation; distinctive species
18. **Soil colour** where visible (§2.7)
19. Terrain form — ridge grain vs chaotic hills vs plain vs plateau dissection
20. Snow, water, sky character
21. Agricultural pattern

**→ `architecture[]`** — with `impliesRegions`:
22. Wall material and **brick colour**
23. Roof form, pitch and material
24. Window and shutter style; balcony form
25. Row-house vs detached; setback; lot width
26. Bridges, stair-streets, retaining walls
27. Signage and shopfront vernacular

**→ `solar`** (only if shadows are visible):
28. Shadow azimuth in degrees
29. Shadow-length-to-object-height ratio (pixels are fine — it's a ratio)
30. Estimated time of day
31. **State explicitly whether a timestamp is available.** Without one, the solar constraint is unusable and must return "no constraint."

**Indoor variant — insert before `architecture`:**
32. **Outlet and switch type** — the strongest indoor signal; describe pin/slot geometry precisely (§3.1)
33. Switch mechanism, plate shape and box geometry (§3.2)
34. Heat emitter and HVAC form (§3.3)
35. Window mechanism and shutter-box presence (§3.4)
36. Ceiling texture and suspended-grid pitch; skirting profile (§3.5)
37. Paper size, date format, units, nutrition-label style, barcode prefix, lamp cap (§3.6)
38. Exit signs, extinguisher class letters, smoke-detector form (§3.7)
39. Toilet water-spot size, bidet presence, washing-machine location (§3.8)
40. **Any view through a window — described as its own set of outdoor observations** (§3.9)

**→ `insufficientSignal: true`** when the walk yields nothing discriminating. A model that says "I can't tell" is more useful than one that guesses, and the product is built to surface that honestly.

---

## Sources

Plonk It (plonkit.net) · GeoHints (geohints.com) · Bellingcat: [reverse image search guide](https://www.bellingcat.com/resources/how-tos/2019/12/26/guide-to-using-reverse-image-search-for-investigations/), [sun and shadows](https://www.bellingcat.com/resources/2020/12/03/using-the-sun-and-the-shadows-for-geolocation/), [ShadowFinder](https://github.com/bellingcat/ShadowFinder), [AI chatbots for geolocation](https://www.bellingcat.com/resources/2023/07/14/can-ai-chatbots-be-used-for-geolocation/), [LLMs vs geolocation](https://www.bellingcat.com/resources/2025/08/14/llms-vs-geolocation-gpt-5-performs-worse-than-other-ai-models/) · [Verification Handbook ch. 4](https://datajournalism.com/read/handbook/verification-1/verifying-images) · [MUTCD 11th ed.](https://mutcd.fhwa.dot.gov/pdfs/11th_Edition/part3.pdf) · [worldstandards.eu plugs & sockets](https://www.worldstandards.eu/electricity/plugs-and-sockets/) · Wikipedia: AC power plugs and sockets, Schuko, BS 1363, AS/NZS 3112, NEMA connector, Mains electricity by country, Light switch, Radiator (heating), Window shutter, Storm window, Tatami, Exit sign, Fire extinguisher, Popcorn ceiling, Artex, Paper size, Date format by country, GS1 country codes, Edison screw, Flush toilet, Bidet, Washing machine · USDA Official Series Descriptions ([Gilpin](https://soilseries.sc.egov.usda.gov/OSD_Docs/G/GILPIN.html), [Hagerstown](https://soilseries.sc.egov.usda.gov/OSD_Docs/H/HAGERSTOWN.html)) · [Steps of Pittsburgh](https://en.wikipedia.org/wiki/Steps_of_Pittsburgh) · [Allegheny County belt system](https://en.wikipedia.org/wiki/Allegheny_County_belt_system) · [Keystone Marker](https://en.wikipedia.org/wiki/Keystone_Marker) · [Father Pitt](https://fatherpitt.com/) · [Pittsburgh Magazine on bridge counts](https://www.pittsburghmagazine.com/does-pittsburgh-really-have-more-bridges-than-any-other-city/) · See also `docs/INTERIOR_MATCHING.md`.
