import { AppDatabase } from '../src/main/database/database'

export function createTestDb(): AppDatabase {
  return new AppDatabase(':memory:')
}

export const testCodec = {
  encrypt(value: string): Buffer { return Buffer.from(`encrypted:${value}`, 'utf8') },
  decrypt(value: Buffer): string { return value.toString('utf8').replace(/^encrypted:/, '') }
}
