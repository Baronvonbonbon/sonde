// snarkjs ships no type declarations; sonde only touches groth16.fullProve/verify.
declare module "snarkjs" {
  export const groth16: {
    fullProve(input: Record<string, unknown>, wasmPath: string, zkeyPath: string): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(vk: unknown, publicSignals: string[], proof: unknown): Promise<boolean>;
  };
}
