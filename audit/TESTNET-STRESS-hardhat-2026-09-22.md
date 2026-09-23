# Testnet stress test — hardhat (chainId 46630)

Deployer 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266. 825 transactions, total gas 151859441. Errors: 0. Failed checks: 0.

## Deployment (placeholders: FeeVault treasury, deployer as keeper, PoolManager copy)

- stockRouter: `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`
- manager: `0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6`
- treasury: `0x8A791620dd6260079BF849Dc5567aDC3F2FdC318`
- curve: `0x610178dA211FEF7D417bC0e6FeD39F05609AD788`
- graduator: `0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e`
- hookDeployer: `0xA51c1fc2f0D1a1b8494Ed1FE312d7C3a78Ed91C0`
- hook: `0x7F0fac90eC4F02eB51095c0fCcefF0C76F5bA0cc`
- hookSalt: `0x000000000000000000000000000000000000000000000000000000000000119e`
- router: `0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1`
- vaultDeployer: `0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE`
- factory: `0x68B1D87F95878fE05B998F19b66F4baba5De1aed`
- weth: `0x5FbDB2315678afecb367f032d93F642f64180aa3`
- stocks: `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`, `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9`, `0x0165878A594ca255338adfa4d48449f69242Eb8F`

## Launches and launch-window buys

| coin | reflection | basket | window buy elapsed s | total bps charged | penalty | formula match |
|---|---|---|---|---|---|---|
| 0 `0x5E3d0fdE6f793B3115A9E7f5EBC195bbeeD35d6C` | 0 | 0 assets | 1 | 818 | 0.0000618 | true |
| 1 `0xa12fFA0B9f159BB4C54bce579611927Addc51610` | 100 | 1 assets | 1 | 918 | 0.0000618 | true |
| 2 `0x53839913417ebc7171723489F29B9B54F49b4EEA` | 300 | 2 assets | 1 | 1118 | 0.0000618 | true |
| 3 `0xB6351eA8b3d83ab563b4d1Fb7818eC231205AF68` | 400 | 3 assets | 1 | 1218 | 0.0000618 | true |

## Curve trades

```
{
  "sent": 500,
  "ok": 500,
  "reverted": 0,
  "feeMismatch": 0,
  "buys": 340,
  "sells": 160,
  "gasMax": "210546",
  "gasTotal": "80845575",
  "byCoin": [
    {
      "buys": 85,
      "sells": 40,
      "feeTotal": "1891406290219201"
    },
    {
      "buys": 85,
      "sells": 40,
      "feeTotal": "2826915549577484"
    },
    {
      "buys": 85,
      "sells": 40,
      "feeTotal": "4692716528820398"
    },
    {
      "buys": 85,
      "sells": 40,
      "feeTotal": "5541512748548543"
    }
  ]
}
```

## Graduations

```
{
  "results": [
    {
      "coin": "0x5E3d0fdE6f793B3115A9E7f5EBC195bbeeD35d6C",
      "accepted": "0.023134810725470545",
      "refund": "0.002",
      "realQuoteAtCap": "0.03",
      "poolId": "0x2e860de278f58aefa16d378434f8087809b26a4f7e42e8b16777d5cb9865d73e",
      "tokensIn": "222222222.222222537143295717",
      "quoteIn": "0.029999999999999872",
      "liquidity": "2581988897471613609034",
      "managerHolds": "222222222.222222537143295717",
      "dust": "0.000000000000007655"
    },
    {
      "coin": "0xa12fFA0B9f159BB4C54bce579611927Addc51610",
      "accepted": "0.023559091050773374",
      "refund": "0.002",
      "realQuoteAtCap": "0.03",
      "poolId": "0x4459f5a9137ed85087112dd2ad557b62583c5a253e021c65d3f3e221a6f52eae",
      "tokensIn": "222222222.2222225716453455",
      "quoteIn": "0.029999999999999874",
      "liquidity": "2581988897471613866741",
      "managerHolds": "222222222.2222225716453455",
      "dust": "0.000000000000013861"
    },
    {
      "coin": "0x53839913417ebc7171723489F29B9B54F49b4EEA",
      "accepted": "0.024753821659377187",
      "refund": "0.002",
      "realQuoteAtCap": "0.03",
      "poolId": "0x8aec04ae5309df9716ad35b1cdb26e013efe50af6fa5e2e650296d75540aca5c",
      "tokensIn": "222222222.222222572368444798",
      "quoteIn": "0.029999999999999874",
      "liquidity": "2581988897471613872142",
      "managerHolds": "222222222.222222572368444798",
      "dust": "0.000000000000029173"
    },
    {
      "coin": "0xB6351eA8b3d83ab563b4d1Fb7818eC231205AF68",
      "accepted": "0.023979091286322002",
      "refund": "0.002",
      "realQuoteAtCap": "0.03",
      "poolId": "0x47f668f8aaf337def673b1803eefae71c37644d2dd8f0f3819967d29095c2300",
      "tokensIn": "222222222.222222568229265055",
      "quoteIn": "0.029999999999999874",
      "liquidity": "2581988897471613841225",
      "managerHolds": "222222222.222222568229265055",
      "dust": "0.000000000000058404"
    }
  ]
}
```

## Pool trades (hook)

```
{
  "sent": 120,
  "ok": 120,
  "reverted": 0,
  "feeMismatch": 0,
  "gasMax": "282860"
}
```

## Rewards

```
{
  "out": [
    {
      "coin": "0x5E3d0fdE6f793B3115A9E7f5EBC195bbeeD35d6C",
      "vault": "0x0000000000000000000000000000000000000000",
      "claims": {
        "creator": "0.000126",
        "treasury": "0.000431438427981347"
      },
      "distributed": null,
      "holdersPaid": 0,
      "insolvent": false
    },
    {
      "coin": "0xa12fFA0B9f159BB4C54bce579611927Addc51610",
      "vault": "0x2b961E3959b79326A8e7F64Ef0d2d825707669b5",
      "claims": {
        "vault": "0.000178107384609962",
        "creator": "0.000249350338453986"
      },
      "distributed": "0.001366003478310175",
      "holdersPaid": 6,
      "insolvent": false
    },
    {
      "coin": "0x53839913417ebc7171723489F29B9B54F49b4EEA",
      "vault": "0x532323de74BAb864b7005D910E5bD8562D038b9b",
      "claims": {
        "vault": "0.00081",
        "creator": "0.000378"
      },
      "distributed": "0.004398244567073543",
      "holdersPaid": 6,
      "insolvent": false
    },
    {
      "coin": "0xB6351eA8b3d83ab563b4d1Fb7818eC231205AF68",
      "vault": "0xD2e813C297f3cf9985bAa5331CEC80778755BF2a",
      "claims": {
        "vault": "0.000723826648102591",
        "creator": "0.000253339326835926"
      },
      "distributed": "0.005417332131921159",
      "holdersPaid": 6,
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

none

Timings (ms): {"deploy":263,"wallets":75,"approvals":112,"launch":135,"trades":8690,"graduate":165,"pool":2237,"rewards":107,"total":11888}
