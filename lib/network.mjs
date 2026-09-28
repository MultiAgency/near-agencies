// Network profiles. NEAR_NETWORK selects one; TREASURY_ACCOUNT may override
// the treasury DAO. Everything network-specific lives here.
const profiles = {
  testnet: {
    networkId: "testnet",
    caip2: "near:testnet",
    usdc: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    rpc: "https://rpc.testnet.fastnear.com",
    fastnearApi: "https://test.api.fastnear.com",
    txApi: "https://tx.test.fastnear.com",
    explorer: "https://testnet.nearblocks.io",
    treasury: "multiagency.sputnikv2.testnet",
    // Trezu is mainnet-only (NEAR-DevHub/trezu nt-fe/README.md).
    trezu: null,
  },
  mainnet: {
    networkId: "mainnet",
    caip2: "near:mainnet",
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    rpc: "https://rpc.mainnet.fastnear.com",
    fastnearApi: "https://api.fastnear.com",
    txApi: "https://tx.main.fastnear.com",
    explorer: "https://nearblocks.io",
    treasury: "multiagency.sputnik-dao.near",
    trezu: "https://trezu.app",
  },
};

const selected = profiles[process.env.NEAR_NETWORK ?? "testnet"];
if (!selected) throw new Error(`NEAR_NETWORK must be one of ${Object.keys(profiles).join(", ")}`);

export const network = {
  ...selected,
  rpc: process.env.RPC_URL ?? selected.rpc,
  treasury: process.env.TREASURY_ACCOUNT ?? selected.treasury,
};

export const txLink = hash => `${network.explorer}/txns/${hash}`;
export const accountLink = account => `${network.explorer}/address/${account}`;
export const trezuRequestLink = id => network.trezu && `${network.trezu}/${network.treasury}/requests/${id}`;
