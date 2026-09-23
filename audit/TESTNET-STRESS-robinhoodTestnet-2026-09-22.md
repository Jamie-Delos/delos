# Testnet stress test — robinhoodTestnet (chainId 46630)

Deployer 0x5fC5cB0d2F026331B5ceaF4e13eff123cd8dFA2b. 903 transactions, total gas 160703017. Errors: 9. Failed checks: 0.

## Deployment (placeholders: FeeVault treasury, deployer as keeper, PoolManager copy)

- stockRouter: `0x75570c6dc43CDbBbF4DD89913B1d3826eB5009C8`
- manager: `0xcb666eB55b44419283b61fd3daBf39376BA87263`
- treasury: `0xaF6da19D04E18C2689b23dd6cCa51b321e5aa9fF`
- curve: `0xCCb59EBa27628382fe9e2FB9dF18586eF86F476D`
- graduator: `0x8d44Fd87e713C460c02b6c791f247bC98EaB952e`
- hookDeployer: `0x2447Ffe54592989B6E775F0D00d4D0967Bb30d82`
- hook: `0x32DA226e5c6bC92653bC80A2D9c963905c94A0Cc`
- hookSalt: `0x0000000000000000000000000000000000000000000000000000000000000b79`
- router: `0xEe50bE767E81703f7C78C0284E372791b9C2d785`
- vaultDeployer: `0x7a4c922Ffc4Be909c3931cC6f5935c458b837f73`
- factory: `0xA313356B20e6920dD3a6724924aFc5F5A4F1d0f2`
- weth: `0x823F4ef19CCE787C7D10483896eE0102F48A88eb`
- stocks: `0xB09b83386CeEf2Ba9D1725EC2E6DA7b93d6a4570`, `0xb526223FF946b318f0d0E4d0C2f78426eb0EAf35`, `0x8B1Ca43188C09D3555C51d6a29A0B9Dc38d74Fee`

## Launches and launch-window buys

| coin | reflection | basket | window buy elapsed s | total bps charged | penalty | formula match |
|---|---|---|---|---|---|---|
| 0 `0x4806D19d1dA9A2CAde208167646613aaD2D3202F` | 0 | 0 assets | 2 | 219 | 0.000000095 | true |
| 1 `0xf1131F57D86ffb1b72Cd7E3611598EE044486E2D` | 100 | 1 assets | 3 | 300 | 0.0 | true |
| 2 `0xEF13B3Cdb9cb367a0C9174732650fcb00afBC5d6` | 300 | 2 assets | 2 | 519 | 0.000000095 | true |
| 3 `0x4297C944EAd305906a5dD6ADf5A990D2F4Ec038C` | 400 | 3 assets | 3 | 600 | 0.0 | true |

## Curve trades

```
{
  "sent": 300,
  "ok": 299,
  "reverted": 1,
  "feeMismatch": 0,
  "buys": 199,
  "sells": 100,
  "gasMax": "198888",
  "gasTotal": "49252443",
  "byCoin": [
    {
      "buys": 50,
      "sells": 25,
      "feeTotal": "59946770180515"
    },
    {
      "buys": 50,
      "sells": 25,
      "feeTotal": "88483120198744"
    },
    {
      "buys": 50,
      "sells": 25,
      "feeTotal": "143346672824165"
    },
    {
      "buys": 49,
      "sells": 25,
      "feeTotal": "170439059202910"
    }
  ]
}
```

## Graduations

```
{
  "results": [
    {
      "coin": "0x4806D19d1dA9A2CAde208167646613aaD2D3202F",
      "accepted": "0.000664762347323678",
      "refund": "0.0002",
      "realQuoteAtCap": "0.0008",
      "poolId": "0x35b779de607e3fd96d76bdde780b8a306cc60eb1298127485b0eeb03513ba2c3",
      "tokensIn": "214285714.285730634091507775",
      "quoteIn": "0.000799999999999995",
      "liquidity": "414039335605432632174",
      "managerHolds": "214285714.285730634091507775",
      "dust": "0.000000000000134214"
    },
    {
      "coin": "0xf1131F57D86ffb1b72Cd7E3611598EE044486E2D",
      "accepted": "0.000634544902493971",
      "refund": "0.0002",
      "realQuoteAtCap": "0.0008",
      "poolId": "0x48d87ee79657860ca42e883c1706fd8141711391e0098197b26547b7976de297",
      "tokensIn": "214285714.285732270052712237",
      "quoteIn": "0.000799999999999996",
      "liquidity": "414039335605434643705",
      "managerHolds": "214285714.285732270052712237",
      "dust": "0.000000000000197898"
    },
    {
      "coin": "0xEF13B3Cdb9cb367a0C9174732650fcb00afBC5d6",
      "accepted": "0.000608523821411212",
      "refund": "0.0002",
      "realQuoteAtCap": "0.0008",
      "poolId": "0x34eabe9580fd0de3a9ad2de28592447b2bd2970c4ea685b8163d65703c0c3118",
      "tokensIn": "214285714.285732546967200079",
      "quoteIn": "0.000799999999999997",
      "liquidity": "414039335605434984191",
      "managerHolds": "214285714.285732546967200079",
      "dust": "0.000000000000373668"
    },
    {
      "coin": "0x4297C944EAd305906a5dD6ADf5A990D2F4Ec038C",
      "accepted": "0.000728561891309018",
      "refund": "0.0002",
      "realQuoteAtCap": "0.0008",
      "poolId": "0x887688b50060c8c09327f141afdea266f6d656f70c8f5be53d4f7c6efbffc244",
      "tokensIn": "214285714.285731190423793895",
      "quoteIn": "0.000799999999999995",
      "liquidity": "414039335605433316224",
      "managerHolds": "214285714.285731190423793895",
      "dust": "0.000000000000485483"
    }
  ]
}
```

## Pool trades (hook)

```
{
  "sent": 47,
  "ok": 40,
  "reverted": 7,
  "feeMismatch": 0,
  "gasMax": "270784"
}
```

## Rewards

```
{
  "out": [
    {
      "coin": "0x4806D19d1dA9A2CAde208167646613aaD2D3202F",
      "vault": "0x0000000000000000000000000000000000000000",
      "claims": {
        "creator": "0.00000308",
        "treasury": "0.000007325755342955"
      },
      "distributed": null,
      "holdersPaid": 0,
      "insolvent": false
    },
    {
      "coin": "0xf1131F57D86ffb1b72Cd7E3611598EE044486E2D",
      "vault": "0xEb9C6bD3e35cd738c26623Cb1a1F0159A958c00F",
      "claims": {
        "vault": "0.000003483516502615",
        "creator": "0.000004876923103668"
      },
      "distributed": "0.00007181205108172",
      "holdersPaid": 3,
      "insolvent": false
    },
    {
      "coin": "0xEF13B3Cdb9cb367a0C9174732650fcb00afBC5d6",
      "vault": "0x7d906b9B46B0517DE6de8345F2588234A4D33B14",
      "claims": {
        "vault": "0.000009",
        "creator": "0.0000042"
      },
      "distributed": "0.000207210793552528",
      "holdersPaid": 3,
      "insolvent": false
    },
    {
      "coin": "0x4297C944EAd305906a5dD6ADf5A990D2F4Ec038C",
      "vault": "0x0D054549D6393170B7442ac077810F229fCa9C14",
      "claims": {
        "vault": "0.000013304302942619",
        "creator": "0.000004656506029921"
      },
      "distributed": "0.000284608705708172",
      "holdersPaid": 3,
      "insolvent": false
    }
  ]
}
```

## Invariant checks

| check | ok | detail |
|---|---|---|
| hook custody == reserved liabilities | PASS | 0.0 vs 0.0 |
| coin 0 supply accounted | PASS | 1000000000.0 / 1000000000.0 |
| coin 0 graduator holds nothing | PASS |  |
| coin 0 graduated | PASS |  |
| coin 0 curve holds only dust | PASS |  |
| coin 1 supply accounted | PASS | 1000000000.0 / 1000000000.0 |
| coin 1 graduator holds nothing | PASS |  |
| coin 1 graduated | PASS |  |
| coin 1 curve holds only dust | PASS |  |
| coin 2 supply accounted | PASS | 1000000000.0 / 1000000000.0 |
| coin 2 graduator holds nothing | PASS |  |
| coin 2 graduated | PASS |  |
| coin 2 curve holds only dust | PASS |  |
| coin 3 supply accounted | PASS | 1000000000.0 / 1000000000.0 |
| coin 3 graduator holds nothing | PASS |  |
| coin 3 graduated | PASS |  |
| coin 3 curve holds only dust | PASS |  |

## Errors

- fatal/main: insufficient funds for gas * price + value: address 0xD0Df3361565E546e36B39ECE4C7927b18c7dd9bd have 2500593333334 want 3860160000000
- trades/buy c3 w7: execution reverted: WETH: insufficient
- pool/sell c1 w1: insufficient funds (wallet gas exhausted; harness budget, not a contract failure)
- pool/sell c1 w1: insufficient funds (wallet gas exhausted; harness budget, not a contract failure)
- pool/sell c1 w1: insufficient funds (wallet gas exhausted; harness budget, not a contract failure)
- pool/sell c1 w1: insufficient funds (wallet gas exhausted; harness budget, not a contract failure)
- pool/sell c1 w1: insufficient funds (wallet gas exhausted; harness budget, not a contract failure)
- pool/sell c1 w1: insufficient funds (wallet gas exhausted; harness budget, not a contract failure)
- pool/sell c1 w1: insufficient funds (wallet gas exhausted; harness budget, not a contract failure)

Timings (ms): {"deploy":71190,"wallets":23464,"approvals":10794,"launch":20760,"trades":215104,"graduate":26015,"pool":45665,"rewards":72466,"total":375303}
