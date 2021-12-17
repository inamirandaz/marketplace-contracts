import { getJSONParams, getJSONValue } from "@zilliqa-js/scilla-json-utils";

import { BN, Zilliqa } from "@zilliqa-js/zilliqa";
import { expect } from "@jest/globals";
import fs from "fs";
import { getAddressFromPrivateKey, schnorr } from "@zilliqa-js/crypto";

import {
  getBNum,
  increaseBNum,
  getErrorMsg,
  ZERO_ADDRESS,
  expectTransitions,
  BalanceTracker,
  expectEvents,
} from "./testutils";

import {
  API,
  TX_PARAMS,
  CONTRACTS,
  FAUCET_PARAMS,
  FIXED_PRICE_ERROR,
  asyncNoop,
} from "./config";

const JEST_WORKER_ID = Number(process.env["JEST_WORKER_ID"]);
const GENESIS_PRIVATE_KEY = global.GENESIS_PRIVATE_KEYS[JEST_WORKER_ID - 1];

const zilliqa = new Zilliqa(API);
zilliqa.wallet.addByPrivateKey(GENESIS_PRIVATE_KEY);

let globalBNum;

let globalTokenAddress;
let globalPaymentTokenAddress;
let globalMarketplaceAddress;
let globalNotAllowedPaymentTokenAddress;

let globalTestAccounts: Array<{
  privateKey: string;
  address: string;
}> = [];
const SELLER = 0;
const BUYER = 1;
const MARKETPLACE_CONTRACT_OWNER = 2;
const STRANGER = 3;
const getTestAddr = (index) => globalTestAccounts[index]?.address as string;

beforeAll(async () => {
  const accounts = Array.from({ length: 5 }, schnorr.generatePrivateKey).map(
    (privateKey) => ({
      privateKey,
      address: getAddressFromPrivateKey(privateKey),
    })
  );

  for (const { privateKey, address } of accounts) {
    zilliqa.wallet.addByPrivateKey(privateKey);
    const tx = await zilliqa.blockchain.createTransaction(
      zilliqa.transactions.new(
        {
          ...FAUCET_PARAMS,
          toAddr: address,
        },
        false
      )
    );
    if (!tx.getReceipt()?.success) {
      throw new Error();
    }
  }
  globalTestAccounts = accounts;

  console.table({
    GENESIS_PRIVATE_KEY,
    SELLER: getTestAddr(SELLER),
    BUYER: getTestAddr(BUYER),
    MARKETPLACE_CONTRACT_OWNER: getTestAddr(MARKETPLACE_CONTRACT_OWNER),
    STRANGER: getTestAddr(STRANGER),
  });

  zilliqa.wallet.setDefault(getTestAddr(STRANGER));

  const init = getJSONParams({
    _scilla_version: ["Uint32", 0],
    contract_owner: ["ByStr20", getTestAddr(STRANGER)],
    name: ["String", CONTRACTS.wzil.name],
    symbol: ["String", CONTRACTS.wzil.symbol],
    decimals: ["Uint32", CONTRACTS.wzil.decimal],
    init_supply: ["Uint128", CONTRACTS.wzil.initial_supply],
  });

  const [, contract] = await zilliqa.contracts
    .new(fs.readFileSync(CONTRACTS.wzil.path).toString(), init)
    .deploy(TX_PARAMS, 33, 1000, true);
  globalNotAllowedPaymentTokenAddress = contract.address;
});

beforeEach(async () => {
  globalBNum = await getBNum(zilliqa);

  // SELLER is the zrc6 contract owner
  zilliqa.wallet.setDefault(getTestAddr(SELLER));

  let init = getJSONParams({
    _scilla_version: ["Uint32", 0],
    initial_contract_owner: ["ByStr20", getTestAddr(SELLER)],
    initial_base_uri: ["String", CONTRACTS.zrc6.baseURI],
    name: ["String", CONTRACTS.zrc6.name],
    symbol: ["String", CONTRACTS.zrc6.symbol],
  });

  let [, contract] = await zilliqa.contracts
    .new(fs.readFileSync(CONTRACTS.zrc6.path).toString(), init)
    .deploy(TX_PARAMS, 33, 1000, true);
  globalTokenAddress = contract.address;

  if (globalTokenAddress === undefined) {
    throw new Error();
  }

  // SELLER mints 3 tokens for self
  let tx: any = await zilliqa.contracts.at(globalTokenAddress).call(
    "BatchMint",
    getJSONParams({
      to_token_uri_pair_list: [
        "List (Pair (ByStr20) (String))",
        [
          [getTestAddr(SELLER), ""],
          [getTestAddr(SELLER), ""],
          [getTestAddr(SELLER), ""],
        ],
      ],
    }),
    TX_PARAMS
  );

  if (!tx.receipt.success) {
    throw new Error();
  }

  // BUYER is the WZIL contract owner
  zilliqa.wallet.setDefault(getTestAddr(BUYER));
  init = getJSONParams({
    _scilla_version: ["Uint32", 0],
    contract_owner: ["ByStr20", getTestAddr(BUYER)],
    name: ["String", CONTRACTS.wzil.name],
    symbol: ["String", CONTRACTS.wzil.symbol],
    decimals: ["Uint32", CONTRACTS.wzil.decimal],
    init_supply: ["Uint128", CONTRACTS.wzil.initial_supply],
  });
  [, contract] = await zilliqa.contracts
    .new(fs.readFileSync(CONTRACTS.wzil.path).toString(), init)
    .deploy(TX_PARAMS, 33, 1000, true);
  globalPaymentTokenAddress = contract.address;

  if (globalPaymentTokenAddress === undefined) {
    throw new Error();
  }

  // MARKETPLACE_CONTRACT_OWNER is the zrc6 marketplace contract owner
  zilliqa.wallet.setDefault(getTestAddr(MARKETPLACE_CONTRACT_OWNER));

  init = getJSONParams({
    _scilla_version: ["Uint32", 0],
    initial_contract_owner: [
      "ByStr20",
      getTestAddr(MARKETPLACE_CONTRACT_OWNER),
    ],
  });
  [, contract] = await zilliqa.contracts
    .new(fs.readFileSync(CONTRACTS.fixed_price.path).toString(), init)
    .deploy(TX_PARAMS, 33, 1000, true);
  globalMarketplaceAddress = contract.address;

  if (globalMarketplaceAddress === undefined) {
    throw new Error();
  }

  // allow WZIL
  tx = await zilliqa.contracts.at(globalMarketplaceAddress).call(
    "AllowPaymentTokenAddress",
    getJSONParams({
      address: ["ByStr20", globalPaymentTokenAddress],
    }),
    TX_PARAMS
  );

  if (!tx.receipt.success) {
    throw new Error();
  }

  // BUYER sets marketplace as spender for ZRC2
  zilliqa.wallet.setDefault(getTestAddr(BUYER));
  tx = await zilliqa.contracts.at(globalPaymentTokenAddress).call(
    "IncreaseAllowance",
    getJSONParams({
      spender: ["ByStr20", globalMarketplaceAddress],
      amount: ["Uint128", 100 * 1000],
    }),
    TX_PARAMS
  );

  if (!tx.receipt.success) {
    throw new Error();
  }

  // SELLER sets marketplace as spender for ZRC6
  zilliqa.wallet.setDefault(getTestAddr(SELLER));
  for (let i = 1; i <= CONTRACTS.zrc6.initial_total_supply; i++) {
    const tx: any = await zilliqa.contracts.at(globalTokenAddress).call(
      "SetSpender",
      getJSONParams({
        spender: ["ByStr20", globalMarketplaceAddress],
        token_id: ["Uint256", i],
      }),
      TX_PARAMS
    );
    if (!tx.receipt.success) {
      throw new Error();
    }
  }
});

describe("Native ZIL", () => {
  beforeEach(async () => {
    // Add marketplace contract as spender for the tokens as SELLER
    zilliqa.wallet.setDefault(getTestAddr(SELLER));
    let tx: any = await zilliqa.contracts.at(globalMarketplaceAddress).call(
      "CreateOrder",
      getJSONParams({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 0],
        expiration_bnum: ["BNum", globalBNum + 5],
      }),
      TX_PARAMS
    );

    if (!tx.receipt.success) {
      throw new Error();
    }

    zilliqa.wallet.setDefault(getTestAddr(BUYER));

    tx = await zilliqa.contracts.at(globalMarketplaceAddress).call(
      "CreateOrder",
      getJSONParams({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 1],
        expiration_bnum: ["BNum", globalBNum + 5],
      }),
      { ...TX_PARAMS, amount: new BN("10000") }
    );

    if (!tx.receipt.success) {
      throw new Error();
    }
  });

  const testCases = [
    {
      name: "Seller creates sell order for token #1",
      transition: "CreateOrder",
      getSender: () => getTestAddr(SELLER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 20000],
        side: ["Uint32", 0],
        expiration_bnum: ["BNum", globalBNum + 5],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 0,
          [getTestAddr(SELLER)]: 0,
          [getTestAddr(BUYER)]: 0,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 0,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "CreateOrder",
            getParams: () => ({
              maker: ["ByStr20", getTestAddr(SELLER).toLowerCase()],
              side: ["Uint32", 0],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", ZERO_ADDRESS],
              sale_price: ["Uint128", 20000],
              expiration_bnum: ["BNum", (globalBNum + 5).toString()],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.sell_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                [1]: {
                  [ZERO_ADDRESS]: {
                    [10000]: getJSONValue(
                      [getTestAddr(SELLER), globalBNum + 5],
                      `${globalMarketplaceAddress}.Order.Order.of.ByStr20.BNum`
                    ),
                    [20000]: getJSONValue(
                      [getTestAddr(SELLER), globalBNum + 5],
                      `${globalMarketplaceAddress}.Order.Order.of.ByStr20.BNum`
                    ),
                  },
                },
              },
            })
          );
        },
      },
    },
    {
      name: "Buyer creates buy order for token #1",
      transition: "CreateOrder",
      txAmount: 20000,
      getSender: () => getTestAddr(BUYER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 20000],
        side: ["Uint32", 1],
        expiration_bnum: ["BNum", globalBNum + 5],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 20000,
          [getTestAddr(SELLER)]: 0,
          [getTestAddr(BUYER)]: -20000,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 0,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "CreateOrder",
            getParams: () => ({
              maker: ["ByStr20", getTestAddr(BUYER).toLowerCase()],
              side: ["Uint32", 1],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", ZERO_ADDRESS],
              sale_price: ["Uint128", 20000],
              expiration_bnum: ["BNum", (globalBNum + 5).toString()],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.buy_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                ["1"]: {
                  [ZERO_ADDRESS]: {
                    [10000]: getJSONValue(
                      [getTestAddr(BUYER), globalBNum + 5],
                      `${globalMarketplaceAddress}.Order.Order.of.ByStr20.BNum`
                    ),
                    [20000]: getJSONValue(
                      [getTestAddr(BUYER), globalBNum + 5],
                      `${globalMarketplaceAddress}.Order.Order.of.ByStr20.BNum`
                    ),
                  },
                },
              },
            })
          );
        },
      },
    },

    {
      name: "throws ExpiredError",
      transition: "FulfillOrder",
      getSender: () => getTestAddr(BUYER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 0],
        dest: ["ByStr20", getTestAddr(BUYER)],
      }),
      beforeTransition: async () => {
        await increaseBNum(zilliqa, 5);
      },
      error: FIXED_PRICE_ERROR.ExpiredError,
      want: undefined,
    },
    {
      name: "throws NotEqualAmountError",
      transition: "FulfillOrder",
      txAmount: 1000,
      getSender: () => getTestAddr(BUYER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 0],
        dest: ["ByStr20", getTestAddr(BUYER)],
      }),
      beforeTransition: asyncNoop,
      error: FIXED_PRICE_ERROR.NotEqualAmountError,
      want: undefined,
    },
    {
      name: "Buyer fullfills sell order",
      transition: "FulfillOrder",
      txAmount: 10000,
      getSender: () => getTestAddr(BUYER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 0],
        dest: ["ByStr20", getTestAddr(BUYER)],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 0,
          [getTestAddr(SELLER)]: 9750,
          [getTestAddr(BUYER)]: -10000,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 250,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "FulfillOrder",
            getParams: () => ({
              taker: ["ByStr20", getTestAddr(BUYER)],
              side: ["Uint32", 0],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", ZERO_ADDRESS],
              sale_price: ["Uint128", 10000],
              seller: ["ByStr20", getTestAddr(SELLER)],
              buyer: ["ByStr20", getTestAddr(BUYER)],
              asset_recipient: ["ByStr20", getTestAddr(BUYER)],
              payment_tokens_recipient: ["ByStr20", getTestAddr(SELLER)],
              royalty_recipient: ["ByStr20", getTestAddr(SELLER)],
              royalty_amount: ["Uint128", 1000],
              service_fee: ["Uint128", 250],
            }),
          },
          // NFT transfer
          {
            name: "TransferFrom",
            getParams: () => ({
              from: ["ByStr20", getTestAddr(SELLER)],
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
        ],
        transitions: [
          {
            amount: 1000,
            recipient: getTestAddr(SELLER),
            tag: "AddFunds",
            getParams: () => ({}),
          },
          {
            amount: 250,
            recipient: getTestAddr(MARKETPLACE_CONTRACT_OWNER),
            tag: "AddFunds",
            getParams: () => ({}),
          },
          {
            amount: 8750,
            recipient: getTestAddr(SELLER),
            tag: "AddFunds",
            getParams: () => ({}),
          },
          // NFT transfer
          {
            tag: "TransferFrom",
            getParams: () => ({
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
          {
            tag: "ZRC6_RecipientAcceptTransferFrom",
            getParams: () => ({
              from: ["ByStr20", getTestAddr(SELLER)],
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
          {
            tag: "ZRC6_TransferFromCallback",
            getParams: () => ({
              from: ["ByStr20", getTestAddr(SELLER)],
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.sell_orders)).toBe(
            JSON.stringify({ [globalTokenAddress.toLowerCase()]: {} })
          );
        },
      },
    },
    {
      name: "Seller fullfills buy order",
      transition: "FulfillOrder",
      getSender: () => getTestAddr(SELLER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 1],
        dest: ["ByStr20", getTestAddr(BUYER)],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: -10000,
          [getTestAddr(SELLER)]: 1000 + 8750,
          [getTestAddr(BUYER)]: 0,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 250,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "FulfillOrder",
            getParams: () => ({
              taker: ["ByStr20", getTestAddr(SELLER)],
              side: ["Uint32", 1],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", ZERO_ADDRESS],
              sale_price: ["Uint128", 10000],
              seller: ["ByStr20", getTestAddr(SELLER)],
              buyer: ["ByStr20", getTestAddr(BUYER)],
              asset_recipient: ["ByStr20", getTestAddr(BUYER)],
              payment_tokens_recipient: ["ByStr20", getTestAddr(SELLER)],
              royalty_recipient: ["ByStr20", getTestAddr(SELLER)],
              royalty_amount: ["Uint128", 1000],
              service_fee: ["Uint128", 250],
            }),
          },

          // NFT transfer
          {
            name: "TransferFrom",
            getParams: () => ({
              from: ["ByStr20", getTestAddr(SELLER)],
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
        ],
        transitions: [
          {
            amount: 1000,
            recipient: getTestAddr(SELLER),
            tag: "AddFunds",
            getParams: () => ({}),
          },
          {
            amount: 250,
            recipient: getTestAddr(MARKETPLACE_CONTRACT_OWNER),
            tag: "AddFunds",
            getParams: () => ({}),
          },
          {
            amount: 8750,
            recipient: getTestAddr(SELLER),
            tag: "AddFunds",
            getParams: () => ({}),
          },
          // NFT transfer
          {
            tag: "TransferFrom",
            getParams: () => ({
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
          {
            tag: "ZRC6_RecipientAcceptTransferFrom",
            getParams: () => ({
              from: ["ByStr20", getTestAddr(SELLER)],
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
          {
            tag: "ZRC6_TransferFromCallback",
            getParams: () => ({
              from: ["ByStr20", getTestAddr(SELLER)],
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.buy_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                [1]: { [ZERO_ADDRESS]: {} },
              },
            })
          );
        },
      },
    },
    {
      name: "throws NotAllowedToCancelOrder by stranger",
      transition: "CancelOrder",
      getSender: () => getTestAddr(STRANGER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 1],
      }),
      beforeTransition: asyncNoop,
      error: FIXED_PRICE_ERROR.NotAllowedToCancelOrder,
    },
    {
      name: "Buyer cancels buy order",
      transition: "CancelOrder",
      getSender: () => getTestAddr(BUYER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 1],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: -10000,
          [getTestAddr(SELLER)]: 0,
          [getTestAddr(BUYER)]: 10000,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 0,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "CancelOrder",
            getParams: () => ({
              maker: ["ByStr20", getTestAddr(BUYER)],
              side: ["Uint32", 1],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", ZERO_ADDRESS],
              sale_price: ["Uint128", 10000],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.buy_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                [1]: { [ZERO_ADDRESS]: {} },
              },
            })
          );
        },
      },
    },
    {
      name: "Seller cancels sell order",
      transition: "CancelOrder",
      getSender: () => getTestAddr(SELLER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", ZERO_ADDRESS],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 0],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 0,
          [getTestAddr(SELLER)]: 0,
          [getTestAddr(BUYER)]: 0,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 0,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "CancelOrder",
            getParams: () => ({
              maker: ["ByStr20", getTestAddr(SELLER)],
              side: ["Uint32", 0],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", ZERO_ADDRESS],
              sale_price: ["Uint128", 10000],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.sell_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                [1]: { [ZERO_ADDRESS]: {} },
              },
            })
          );
        },
      },
    },
  ];

  for (const testCase of testCases) {
    it(`${testCase.transition}: ${testCase.name}`, async () => {
      await testCase.beforeTransition();

      let balanceTracker;
      if (testCase.want) {
        const accounts = Object.keys(await testCase.want.getBalanceDeltas());
        balanceTracker = new BalanceTracker(zilliqa, accounts);
        await balanceTracker.get();
      }

      zilliqa.wallet.setDefault(testCase.getSender());

      const tx: any = await zilliqa.contracts
        .at(globalMarketplaceAddress)
        .call(testCase.transition, getJSONParams(testCase.getParams()), {
          ...TX_PARAMS,
          amount: new BN(testCase.txAmount || 0),
        });

      if (testCase.want === undefined) {
        // Nagative Cases
        expect(tx.receipt.success).toBe(false);
        expect(tx.receipt.exceptions[0].message).toBe(
          getErrorMsg(testCase.error)
        );
      } else {
        // Positive Cases

        expect(tx.receipt.success).toBe(true);
        expectEvents(tx.receipt.event_logs, testCase.want.events);

        testCase.want.transitions &&
          expectTransitions(tx.receipt.transitions, testCase.want.transitions);

        const state = await zilliqa.contracts
          .at(globalMarketplaceAddress)
          .getState();

        testCase.want.expectState(state);

        if (balanceTracker) {
          const deltasReceived = await balanceTracker.deltas();
          const deltasExpected = await testCase.want?.getBalanceDeltas();
          deltasReceived.forEach(([account, delta]) => {
            if (
              balanceTracker.zrc2 === undefined &&
              account.toLowerCase() === testCase.getSender().toLowerCase()
            ) {
              const txFee = new BN(tx.receipt.cumulative_gas).mul(tx.gasPrice);
              const deltaWithFee = new BN(delta).add(txFee);
              expect(`${account}:${deltaWithFee.toString()}`).toBe(
                `${account}:${deltasExpected[account]?.toString()}`
              );
            } else {
              expect(`${account}:${delta}`).toBe(
                `${account}:${deltasExpected[account]?.toString()}`
              );
            }
          });
        }
      }
    });
  }
});

describe("WZIL", () => {
  beforeEach(async () => {
    // Add marketplace contract as spender for the tokens as SELLER
    zilliqa.wallet.setDefault(getTestAddr(SELLER));

    let tx: any = await zilliqa.contracts.at(globalMarketplaceAddress).call(
      "CreateOrder",
      getJSONParams({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 0],
        expiration_bnum: ["BNum", globalBNum + 5],
      }),
      TX_PARAMS
    );

    if (!tx.receipt.success) {
      throw new Error();
    }

    zilliqa.wallet.setDefault(getTestAddr(BUYER));

    tx = await zilliqa.contracts.at(globalMarketplaceAddress).call(
      "CreateOrder",
      getJSONParams({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 1],
        expiration_bnum: ["BNum", globalBNum + 5],
      }),
      TX_PARAMS
    );

    if (!tx.receipt.success) {
      throw new Error();
    }
  });

  const testCases = [
    {
      name: "throws NotAllowedPaymentToken",
      transition: "CreateOrder",
      getSender: () => getTestAddr(SELLER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalNotAllowedPaymentTokenAddress],
        sale_price: ["Uint128", 20000],
        side: ["Uint32", 0], // 0 is sell, 1 is buy,
        expiration_bnum: ["BNum", globalBNum + 5],
      }),
      beforeTransition: asyncNoop,
      error: FIXED_PRICE_ERROR.NotAllowedPaymentToken,
      want: undefined,
    },
    {
      name: "Seller creates sell order for token #1",
      transition: "CreateOrder",
      getSender: () => getTestAddr(SELLER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 20000],
        side: ["Uint32", 0],
        expiration_bnum: ["BNum", globalBNum + 5],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 0,
          [getTestAddr(SELLER)]: 0,
          [getTestAddr(BUYER)]: 0,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 0,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "CreateOrder",
            getParams: () => ({
              maker: ["ByStr20", getTestAddr(SELLER).toLowerCase()],
              side: ["Uint32", 0],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", globalPaymentTokenAddress],
              sale_price: ["Uint128", 20000],
              expiration_bnum: ["BNum", (globalBNum + 5).toString()],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.sell_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                [1]: {
                  [globalPaymentTokenAddress.toLowerCase()]: {
                    [10000]: getJSONValue(
                      [getTestAddr(SELLER), globalBNum + 5],
                      `${globalMarketplaceAddress}.Order.Order.of.ByStr20.BNum`
                    ),
                    [20000]: getJSONValue(
                      [getTestAddr(SELLER), globalBNum + 5],
                      `${globalMarketplaceAddress}.Order.Order.of.ByStr20.BNum`
                    ),
                  },
                },
              },
            })
          );
        },
      },
    },
    {
      name: "Buyer creates buy order for token #1",
      transition: "CreateOrder",
      getSender: () => getTestAddr(BUYER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 20000],
        side: ["Uint32", 1],
        expiration_bnum: ["BNum", globalBNum + 5],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 0,
          [getTestAddr(SELLER)]: 0,
          [getTestAddr(BUYER)]: 0,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 0,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "CreateOrder",
            getParams: () => ({
              maker: ["ByStr20", getTestAddr(BUYER).toLowerCase()],
              side: ["Uint32", 1],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", globalPaymentTokenAddress],
              sale_price: ["Uint128", 20000],
              expiration_bnum: ["BNum", (globalBNum + 5).toString()],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.buy_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                [1]: {
                  [globalPaymentTokenAddress.toLowerCase()]: {
                    [10000]: getJSONValue(
                      [getTestAddr(BUYER), globalBNum + 5],
                      `${globalMarketplaceAddress}.Order.Order.of.ByStr20.BNum`
                    ),
                    [20000]: getJSONValue(
                      [getTestAddr(BUYER), globalBNum + 5],
                      `${globalMarketplaceAddress}.Order.Order.of.ByStr20.BNum`
                    ),
                  },
                },
              },
            })
          );
        },
      },
    },
    {
      name: "throws ExpiredError",
      transition: "FulfillOrder",
      getSender: () => getTestAddr(BUYER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 0],
        dest: ["ByStr20", getTestAddr(BUYER)],
      }),
      beforeTransition: async () => {
        await increaseBNum(zilliqa, 5);
      },
      error: FIXED_PRICE_ERROR.ExpiredError,
      want: undefined,
    },
    {
      name: "Buyer fullfills sell order",
      transition: "FulfillOrder",
      getSender: () => getTestAddr(BUYER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 0],
        dest: ["ByStr20", getTestAddr(BUYER)],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 0,
          [getTestAddr(SELLER)]: 9750,
          [getTestAddr(BUYER)]: -10000,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 250,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "FulfillOrder",
            getParams: () => ({
              taker: ["ByStr20", getTestAddr(BUYER)],
              side: ["Uint32", 0],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", globalPaymentTokenAddress],
              sale_price: ["Uint128", 10000],
              seller: ["ByStr20", getTestAddr(SELLER)],
              buyer: ["ByStr20", getTestAddr(BUYER)],
              asset_recipient: ["ByStr20", getTestAddr(BUYER)],
              payment_tokens_recipient: ["ByStr20", getTestAddr(SELLER)],
              royalty_recipient: ["ByStr20", getTestAddr(SELLER)],
              royalty_amount: ["Uint128", 1000],
              service_fee: ["Uint128", 250],
            }),
          },

          // royalty fee
          {
            name: "TransferFromSuccess",
            getParams: () => ({
              initiator: ["ByStr20", globalMarketplaceAddress],
              sender: ["ByStr20", getTestAddr(BUYER)],
              recipient: ["ByStr20", getTestAddr(SELLER)],
              amount: ["Uint128", 1000],
            }),
          },

          // service fee
          {
            name: "TransferFromSuccess",
            getParams: () => ({
              initiator: ["ByStr20", globalMarketplaceAddress],
              sender: ["ByStr20", getTestAddr(BUYER)],
              recipient: ["ByStr20", getTestAddr(MARKETPLACE_CONTRACT_OWNER)],
              amount: ["Uint128", 250],
            }),
          },

          // seller profit
          {
            name: "TransferFromSuccess",
            getParams: () => ({
              initiator: ["ByStr20", globalMarketplaceAddress],
              sender: ["ByStr20", getTestAddr(BUYER)],
              recipient: ["ByStr20", getTestAddr(SELLER)],
              amount: ["Uint128", 8750],
            }),
          },

          // NFT transfer
          {
            name: "TransferFrom",
            getParams: () => ({
              from: ["ByStr20", getTestAddr(SELLER)],
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.sell_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {},
            })
          );
        },
      },
    },
    {
      name: "Seller fullfills buy order",
      transition: "FulfillOrder",
      getSender: () => getTestAddr(SELLER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 1],
        dest: ["ByStr20", getTestAddr(BUYER)],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 0,
          [getTestAddr(SELLER)]: 1000 + 8750,
          [getTestAddr(BUYER)]: -10000,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 250,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "FulfillOrder",
            getParams: () => ({
              taker: ["ByStr20", getTestAddr(SELLER)],
              side: ["Uint32", 1],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", globalPaymentTokenAddress],
              sale_price: ["Uint128", 10000],
              seller: ["ByStr20", getTestAddr(SELLER)],
              buyer: ["ByStr20", getTestAddr(BUYER)],
              asset_recipient: ["ByStr20", getTestAddr(BUYER)],
              payment_tokens_recipient: ["ByStr20", getTestAddr(SELLER)],
              royalty_recipient: ["ByStr20", getTestAddr(SELLER)],
              royalty_amount: ["Uint128", 1000],
              service_fee: ["Uint128", 250],
            }),
          },

          // royalty fee
          {
            name: "TransferFromSuccess",
            getParams: () => ({
              initiator: ["ByStr20", globalMarketplaceAddress],
              sender: ["ByStr20", getTestAddr(BUYER)],
              recipient: ["ByStr20", getTestAddr(SELLER)],
              amount: ["Uint128", 1000],
            }),
          },

          // service fee
          {
            name: "TransferFromSuccess",
            getParams: () => ({
              initiator: ["ByStr20", globalMarketplaceAddress],
              sender: ["ByStr20", getTestAddr(BUYER)],
              recipient: ["ByStr20", getTestAddr(MARKETPLACE_CONTRACT_OWNER)],
              amount: ["Uint128", 250],
            }),
          },

          // seller profit
          {
            name: "TransferFromSuccess",
            getParams: () => ({
              initiator: ["ByStr20", globalMarketplaceAddress],
              sender: ["ByStr20", getTestAddr(BUYER)],
              recipient: ["ByStr20", getTestAddr(SELLER)],
              amount: ["Uint128", 8750],
            }),
          },

          // NFT transfer
          {
            name: "TransferFrom",
            getParams: () => ({
              from: ["ByStr20", getTestAddr(SELLER)],
              to: ["ByStr20", getTestAddr(BUYER)],
              token_id: ["Uint256", 1],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.buy_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                [1]: { [globalPaymentTokenAddress.toLowerCase()]: {} },
              },
            })
          );
        },
      },
    },
    {
      name: "throws NotAllowedToCancelOrder by stranger",
      transition: "CancelOrder",
      getSender: () => getTestAddr(STRANGER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 1],
      }),
      beforeTransition: asyncNoop,
      error: FIXED_PRICE_ERROR.NotAllowedToCancelOrder,
    },
    {
      name: "Buyer cancels buy order",
      transition: "CancelOrder",
      getSender: () => getTestAddr(BUYER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 1],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 0,
          [getTestAddr(SELLER)]: 0,
          [getTestAddr(BUYER)]: 0,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 0,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "CancelOrder",
            getParams: () => ({
              maker: ["ByStr20", getTestAddr(BUYER)],
              side: ["Uint32", 1],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", globalPaymentTokenAddress],
              sale_price: ["Uint128", 10000],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.buy_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                [1]: { [globalPaymentTokenAddress.toLowerCase()]: {} },
              },
            })
          );
        },
      },
    },
    {
      name: "Seller cancels sell order",
      transition: "CancelOrder",
      getSender: () => getTestAddr(SELLER),
      getParams: () => ({
        token_address: ["ByStr20", globalTokenAddress],
        token_id: ["Uint256", 1],
        payment_token_address: ["ByStr20", globalPaymentTokenAddress],
        sale_price: ["Uint128", 10000],
        side: ["Uint32", 0],
      }),
      beforeTransition: asyncNoop,
      error: undefined,
      want: {
        getBalanceDeltas: () => ({
          [globalMarketplaceAddress]: 0,
          [getTestAddr(SELLER)]: 0,
          [getTestAddr(BUYER)]: 0,
          [getTestAddr(MARKETPLACE_CONTRACT_OWNER)]: 0,
          [getTestAddr(STRANGER)]: 0,
        }),
        events: [
          {
            name: "CancelOrder",
            getParams: () => ({
              maker: ["ByStr20", getTestAddr(SELLER)],
              side: ["Uint32", 0],
              token_address: ["ByStr20", globalTokenAddress],
              token_id: ["Uint256", 1],
              payment_token_address: ["ByStr20", globalPaymentTokenAddress],
              sale_price: ["Uint128", 10000],
            }),
          },
        ],
        expectState: (state) => {
          expect(JSON.stringify(state.sell_orders)).toBe(
            JSON.stringify({
              [globalTokenAddress.toLowerCase()]: {
                [1]: { [globalPaymentTokenAddress.toLowerCase()]: {} },
              },
            })
          );
        },
      },
    },
  ];

  for (const testCase of testCases) {
    it(`${testCase.transition}: ${testCase.name}`, async () => {
      await testCase.beforeTransition();

      let balanceTracker;
      if (testCase.want) {
        const accounts = Object.keys(await testCase.want.getBalanceDeltas());
        balanceTracker = new BalanceTracker(zilliqa, accounts, {
          zrc2: globalPaymentTokenAddress,
        });
        await balanceTracker.get();
      }

      zilliqa.wallet.setDefault(testCase.getSender());

      const tx: any = await zilliqa.contracts
        .at(globalMarketplaceAddress)
        .call(testCase.transition, getJSONParams(testCase.getParams()), {
          ...TX_PARAMS,
        });

      if (testCase.want === undefined) {
        // Nagative Cases
        expect(tx.receipt.success).toBe(false);
        expect(tx.receipt.exceptions[0].message).toBe(
          getErrorMsg(testCase.error)
        );
      } else {
        // Positive Cases
        expect(tx.receipt.success).toBe(true);
        expectEvents(tx.receipt.event_logs, testCase.want.events);

        const state = await zilliqa.contracts
          .at(globalMarketplaceAddress)
          .getState();

        testCase.want.expectState(state);

        if (balanceTracker) {
          const deltasReceived = await balanceTracker.deltas();
          const deltasExpected = await testCase.want?.getBalanceDeltas();
          deltasReceived.forEach(([account, delta]) => {
            if (
              balanceTracker.zrc2 === undefined &&
              account.toLowerCase() === testCase.getSender().toLowerCase()
            ) {
              const txFee = new BN(tx.receipt.cumulative_gas).mul(tx.gasPrice);
              const deltaWithFee = new BN(delta).add(txFee);
              expect(`${account}:${deltaWithFee.toString()}`).toBe(
                `${account}:${deltasExpected[account]?.toString()}`
              );
            } else {
              expect(`${account}:${delta}`).toBe(
                `${account}:${deltasExpected[account]?.toString()}`
              );
            }
          });
        }
      }
    });
  }
});