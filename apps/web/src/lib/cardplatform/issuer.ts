export function canonicalCardIssuer(value: string) {
  switch (value.trim().toLowerCase()) {
    case "one":
    case "1":
    case "ch1":
    case "channel1":
    case "vmcard":
    case "vmcardio":
      return "one";
    case "two":
    case "2":
    case "ch2":
    case "channel2":
      return "two";
    case "three":
    case "3":
    case "ch3":
    case "channel3":
    case "yika":
    case "yikahk":
      return "three";
    case "four":
    case "4":
    case "ch4":
    case "channel4":
    case "photon":
    case "photonpay":
      return "four";
    default:
      return "";
  }
}

export function issuerChannelLabel(value: string) {
  switch (canonicalCardIssuer(value) || value.trim().toLowerCase()) {
    case "one":
      return "渠道1";
    case "two":
      return "渠道2";
    case "three":
      return "渠道3";
    case "four":
      return "渠道4";
    default:
      return value.trim() || "—";
  }
}

export function issuerParticipatesInAutoSelect(value: string) {
  const issuer = canonicalCardIssuer(value);
  return issuer === "one" || issuer === "three" || issuer === "four";
}
