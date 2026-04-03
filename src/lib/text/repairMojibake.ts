const SUSPICIOUS_MOJIBAKE_PATTERN =
  /(Р[А-Яа-яЁёЀ-ӿ]|С[А-Яа-яЁёЀ-ӿ]|вЂ|в„–|ѓ|ќ|џ|Ў|ў|Ћ|Ќ|Љ|Њ|љ|њ|Рў|Рџ|РЎ)/;

const CYRILLIC_PATTERN = /[А-Яа-яЁё]/;

const CP1251_EXTRA_ENCODE_MAP: Record<string, number> = {
  "Ђ": 0x80,
  "Ѓ": 0x81,
  "‚": 0x82,
  "ѓ": 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  "€": 0x88,
  "‰": 0x89,
  "Љ": 0x8a,
  "‹": 0x8b,
  "Њ": 0x8c,
  "Ќ": 0x8d,
  "Ћ": 0x8e,
  "Џ": 0x8f,
  "ђ": 0x90,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "™": 0x99,
  "љ": 0x9a,
  "›": 0x9b,
  "њ": 0x9c,
  "ќ": 0x9d,
  "ћ": 0x9e,
  "џ": 0x9f,
  " ": 0xa0,
  "Ў": 0xa1,
  "ў": 0xa2,
  "Ј": 0xa3,
  "¤": 0xa4,
  "Ґ": 0xa5,
  "¦": 0xa6,
  "§": 0xa7,
  "Ё": 0xa8,
  "©": 0xa9,
  "Є": 0xaa,
  "«": 0xab,
  "¬": 0xac,
  "­": 0xad,
  "®": 0xae,
  "Ї": 0xaf,
  "°": 0xb0,
  "±": 0xb1,
  "І": 0xb2,
  "і": 0xb3,
  "ґ": 0xb4,
  "µ": 0xb5,
  "¶": 0xb6,
  "·": 0xb7,
  "ё": 0xb8,
  "№": 0xb9,
  "є": 0xba,
  "»": 0xbb,
  "ј": 0xbc,
  "Ѕ": 0xbd,
  "ѕ": 0xbe,
  "ї": 0xbf,
};

const encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const encodeCp1251Char = (char: string): number | null => {
  const code = char.charCodeAt(0);

  if (code <= 0x7f) {
    return code;
  }

  if (char in CP1251_EXTRA_ENCODE_MAP) {
    return CP1251_EXTRA_ENCODE_MAP[char];
  }

  if (code >= 0x0410 && code <= 0x044f) {
    return code - 0x350;
  }

  return null;
};

const decodeCp1251Mojibake = (value: string): string | null => {
  const bytes: number[] = [];

  for (const char of value) {
    const encoded = encodeCp1251Char(char);
    if (encoded === null) {
      return null;
    }
    bytes.push(encoded);
  }

  try {
    return utf8Decoder.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
};

export const repairMojibake = (value: string): string => {
  if (!value || !SUSPICIOUS_MOJIBAKE_PATTERN.test(value)) {
    return value;
  }

  let current = value;
  for (let index = 0; index < 3; index += 1) {
    const repaired = decodeCp1251Mojibake(current);
    if (!repaired || repaired === current) {
      break;
    }

    current = repaired;
    if (!SUSPICIOUS_MOJIBAKE_PATTERN.test(current)) {
      break;
    }
  }

  return current;
};

export const repairMojibakeDeep = <T>(value: T): T => {
  if (typeof value === "string") {
    return repairMojibake(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => repairMojibakeDeep(item)) as T;
  }

  if (value && typeof value === "object") {
    const nextEntries = Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
      key,
      repairMojibakeDeep(entryValue),
    ]);
    return Object.fromEntries(nextEntries) as T;
  }

  return value;
};

export const looksLikeMojibake = (value: string): boolean => {
  return Boolean(value) && SUSPICIOUS_MOJIBAKE_PATTERN.test(value);
};

export const isReadableCyrillic = (value: string): boolean => {
  return CYRILLIC_PATTERN.test(value);
};

export const repairTextForDisplay = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return repairMojibake(value);
};

export const repairBytesRoundtrip = (value: string): string => {
  if (!value) return value;
  try {
    const bytes = encoder.encode(value);
    return utf8Decoder.decode(bytes);
  } catch {
    return value;
  }
};
