# Shelly Pro 3EM – net metering (Saldierung)

## Overview

To accurately determine energy values, power is continuously integrated over the
measured time in order to obtain a precise net energy balance.
Whenever the Shelly energy meters update, the result of this integration is compared
against the more accurate energy meter values provided by the Shelly device and
corrected accordingly.

The **Shelly Pro 3EM** does **not** calculate phase-balanced energy internally.

If power is imported on one phase while energy is exported on another phase at the same time, the device increments **both**:

- `total_energy`
- `total_energy_returned`

even though the **net power flow is close to zero**.

This behavior is **firmware-related** and identical across:

- Web UI
- RPC
- MQTT
- Home Assistant
- Internal scripts

Polling the internal energy counters more frequently does **not** improve accuracy.

---

## Problem

Because Shelly accumulates **absolute per-phase energy**, its internal counters:

- cannot represent real net energy flow
- drift in systems with simultaneous import and export
- are unsuitable for PV, batteries, or phase-mixed loads

This is a firmware design limitation.

---

## Solution

This script implements **true phase-balanced energy measurement** by:

1. Reading **total active power** (sum of all phases)
2. Integrating power over **real elapsed time (dt)**
3. Separating **import and export by sign**
4. Optionally correcting the integration using Shelly’s internal counters as a **slow reference**
5. Storing results in **persisted virtual number components** (Wh)

This mirrors how a real bidirectional energy meter works.

---

## License

MIT / Public Domain – use at your own risk.

## Disclaimer

This project is provided "as is", without any warranty of any kind.
The author does not guarantee correctness, completeness, or suitability
for any specific purpose and assumes no responsibility for damages,
data loss, or incorrect measurements resulting from the use of this
script or its documentation.

Parts of this script and the accompanying documentation were created
with the assistance of artificial intelligence (AI).
All content was reviewed and adapted by the author, but no claim is made
that the implementation is free of errors.

Use at your own risk.

---

# Shelly Pro 3EM – Phasen-balancierte Energieerfassung

## Überblick

Für die genaue Ermittlung der Energiewerte wird die Leistung über die gemessene Zeit
integriert, um daraus eine möglichst genaue Netto-Saldierung zu erreichen.
Sobald sich die Energiezähler des Shelly aktualisieren, wird das Ergebnis dieser
Integration mit den genaueren Werten der Shelly-Energiezähler abgeglichen und
entsprechend korrigiert.

Der **Shelly Pro 3EM** berechnet intern **keine phasen-balancierte Energie**.

Wenn auf einer Phase Energie bezogen und gleichzeitig auf einer anderen Phase eingespeist wird, erhöht das Gerät **beide** Zähler:

- `total_energy`
- `total_energy_returned`

obwohl die **Nettoleistung nahe null** ist.

Dieses Verhalten ist **firmwarebedingt** und identisch in:

- Web-UI
- RPC
- MQTT
- Home Assistant
- internen Skripten

Häufigeres Abfragen der Zähler verbessert die Genauigkeit **nicht**.

---

## Lösung

Dieses Skript realisiert eine **physikalisch korrekte, phasen-balancierte Energieerfassung** durch:

1. Lesen der **Gesamtwirkleistung** (Summe aller Phasen)
2. Integration der Leistung über die **tatsächlich vergangene Zeit**
3. Trennung von Bezug und Einspeisung über das Vorzeichen
4. Optionale Korrektur über Shelly-Zähler als **langsame Referenz**
5. Speicherung in **persistenten virtuellen Zählern** (Wh)

Das Verhalten entspricht einem realen bidirektionalen Stromzähler.

---

## Lizenz

MIT / Public Domain – Nutzung auf eigene Verantwortung.

## Haftungsausschluss

Dieses Projekt wird ohne jegliche Gewährleistung bereitgestellt.
Der Autor übernimmt keine Verantwortung für die Richtigkeit,
Vollständigkeit oder Eignung für einen bestimmten Zweck sowie für
eventuelle Schäden, Datenverluste oder Fehlmessungen, die durch die
Nutzung dieses Skripts oder der dazugehörigen Dokumentation entstehen.

Teile dieses Skripts sowie die begleitende Dokumentation wurden unter
Einsatz von künstlicher Intelligenz (KI) erstellt.
Die Inhalte wurden vom Autor geprüft und angepasst, es wird jedoch
keine Garantie für Fehlerfreiheit übernommen.

Die Nutzung erfolgt auf eigene Verantwortung.
