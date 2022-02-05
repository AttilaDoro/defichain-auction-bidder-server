require('dotenv').config();
const express = require('express');
const { JsonRpcClient } = require('@defichain/jellyfish-api-jsonrpc');
const BigNumber = require('bignumber.js');
const cors = require('cors');
const SimpleNodeLogger = require('simple-node-logger');

const logger = SimpleNodeLogger.createSimpleFileLogger({
  logFilePath: `${Date.now()}.log`,
  timestampFormat: 'YYYY-MM-DD HH:mm:ss.SSS',
});
const app = express();
const client = new JsonRpcClient(process.env.CLIENT_ENDPOINT_URL);

const logError = (message, error) => {
  logger.error(message);
  console.log(message, error);
};

const logInfo = (message) => {
  logger.info(message);
  console.log(message);
};

const checkRequiredConfig = () => {
  const { CLIENT_ENDPOINT_URL, PORT, COOL_DOWN } = process.env;
  if (!CLIENT_ENDPOINT_URL || !PORT || !COOL_DOWN) {
    logError('MISSING REQUIRED CONFIG SETTING');
    process.exit();
  }
};

// eslint-disable-next-line no-promise-executor-return
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

checkRequiredConfig();

app.use(cors());

const getAvailableAuctions = async (limit) => {
  const availableAuctions = await client.loan.listAuctions({ limit });
  return availableAuctions.reduce((acc, { vaultId, batches }) => {
    const transformedBatches = batches.map(batch => ({ ...batch, vaultId }));
    return [...acc, ...transformedBatches];
  }, []);
};

const getPriceInDUSD = async (amount, symbol) => {
  try {
    if (symbol === 'DFI') {
      const poolPair = await client.poolpair.getPoolPair('DUSD-DFI');
      const [rate] = Object.entries(poolPair).map(([, pair]) => pair['reserveA/reserveB']);
      return rate.multipliedBy(amount);
    }
    const poolPair = await client.poolpair.getPoolPair(`${symbol}-DUSD`);
    const [rate] = Object.entries(poolPair).map(([, pair]) => pair['reserveB/reserveA']);
    return rate.multipliedBy(amount);
  } catch (error) {
    if (error.message.includes('Pool not found')) {
      const [firstPair, secondPair] = await Promise.all([
        client.poolpair.getPoolPair(`${symbol}-DFI`),
        client.poolpair.getPoolPair('DUSD-DFI'),
      ]);
      const [firstRate] = Object.entries(firstPair).map(([, pair]) => pair['reserveB/reserveA']);
      const [secondRate] = Object.entries(secondPair).map(([, pair]) => pair['reserveA/reserveB']);
      return firstRate.multipliedBy(amount).multipliedBy(secondRate);
    }
    logError('getPriceInDUSD error', error);
    return null;
  }
};

const getHighestBidSoFar = async (vaultId, batchIndex) => {
  try {
    const vault = await client.loan.getVault(vaultId);
    return vault.batches?.[batchIndex]?.highestBid;
  } catch (error) {
    logError('getVault error', error);
    return null;
  }
};

const getStartingBid = async ({ vaultId, index, loan }) => {
  const highestBidSoFar = await getHighestBidSoFar(vaultId, index);
  const [amount, symbol] = loan.split('@');

  if (!highestBidSoFar) {
    const loanNum = await getPriceInDUSD(amount, symbol);
    return loanNum.multipliedBy('1.05');
  }

  const [highestBidAmount] = highestBidSoFar.amount.split('@');
  const highestBidSoFarNum = await getPriceInDUSD(highestBidAmount, symbol);
  return highestBidSoFarNum.multipliedBy('1.01');
};

const getRewardPrice = async (collaterals) => {
  const pricePromises = collaterals.map((collateral) => {
    const [amount, symbol] = collateral.split('@');
    return getPriceInDUSD(amount, symbol);
  });
  const prices = await Promise.all(pricePromises);
  return prices.reduce((sum, price) => sum.plus(price), new BigNumber(0));
};

const sortyByMargin = ({ margin: first }, { margin: second }) => {
  if (first.isGreaterThan(second)) return -1;
  if (second.isGreaterThan(first)) return 1;
  return 0;
};

app.get('/get-auction-list/:limit', async (req, res) => {
  try {
    const limit = parseInt(req.params.limit, 10);
    const { minMarginPercentage = 0 } = req.query;
    const availableAuctions = await getAvailableAuctions(limit);

    const result = [];
    for (let index = 0; index < availableAuctions.length; index += 1) {
      const auction = availableAuctions[index];
      const startingBid = await getStartingBid(auction);
      const reward = await getRewardPrice(auction.collaterals);
      const url = `https://defiscan.live/vaults/${auction.vaultId}/auctions/${auction.index}`;
      const diff = reward.minus(startingBid);
      const margin = diff.dividedBy(startingBid).multipliedBy(100);
      const coolDown = parseInt(process.env.COOL_DOWN, 10);
      wait(coolDown);
      if (margin.isGreaterThanOrEqualTo(minMarginPercentage)) {
        result.push({ url, minBid: startingBid, reward, diff, margin });
      }
    }
    result.sort(sortyByMargin);
    result.reverse();
    const auctions = result.map(({ url, minBid, reward, diff, margin }) => ({
      url,
      minBid: `${minBid.toPrecision(10)} DUSD`,
      reward: `${reward.toPrecision(10)} DUSD`,
      diff: `${diff.toPrecision(7)} DUSD`,
      margin: `${margin.toPrecision(5)}%`,
    }));
    res.json(auctions);
  } catch (error) {
    logError('get-auction-list error', error);
    res.status(500);
    res.send('Internal Server Error');
  }
});

app.listen(parseInt(process.env.PORT, 10), () => {
  console.log(`Example app listening on port ${process.env.PORT}`);
});
