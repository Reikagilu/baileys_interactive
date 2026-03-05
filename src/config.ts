import dotenv from 'dotenv';

dotenv.config();

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export const config = {
  port: parseInt(process.env.PORT ?? '8787', 10),
  apiKey: process.env.API_KEY ?? 'ACFH4RFOTME4RU50R4FKGNW34LDFG8DSQ',
  authFolder: process.env.AUTH_FOLDER ?? 'auth',
  pairing: {
    enabled: parseBoolean(process.env.PAIRING_CODE_ENABLED, true),
    defaultCountryCode: (process.env.PAIRING_DEFAULT_COUNTRY_CODE ?? '55').replace(/\D/g, ''),
  },
  limits: {
    maxButtons: 3,
    maxCarouselCards: 10,
    maxListSections: 10,
    maxListRowsPerSection: 10,
    maxPollOptions: 12,
  },
} as const;

export type Config = typeof config;
