// Firmware versioning. See docs/OTA.md §3.
//
//   BL_FW_BUILD    — monotonic integer. The OTA gate AND the firmware's wire
//                    identity (station.build > device.build → offer). Bump +1
//                    every firmware release that ships an OTA artifact. This is
//                    the ONLY version the OTA path uses.
//   BL_FW_VERSION  — human SemVer string. NOT sent on the OTA wire; the station
//                    owns build→label metadata (its meta.json). Kept here only
//                    because the BodyLink phone-facing `profile` advertises a
//                    `fw_version` field (separate, pre-OTA concern).
//
// build-body.sh reads BL_FW_BUILD into the artifact's meta.json so the recorded
// build can't disagree with the binary.

#pragma once

#define BL_FW_VERSION "0.2.0"
#define BL_FW_BUILD   5
