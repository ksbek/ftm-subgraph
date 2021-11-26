import { PairHourData } from './../types/schema'
/* eslint-disable prefer-const */
import { BigInt, BigDecimal, store, Address } from '@graphprotocol/graph-ts'
import {
  Pair,
  Token,
  HyperswapFactory,
  Transaction,
  HyperswapDayData,
  PairDayData,
  TokenDayData,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle
} from '../types/schema'
import { Pair as PairContract, Mint, Burn, Swap, Transfer, Sync } from '../types/templates/Pair/Pair'
import { updatePairDayData, updateTokenDayData, updateHyperswapDayData, updatePairHourData } from './dayUpdates'
import { getFtmPriceInUSD, findFtmPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from './pricing'
import {
  convertTokenToDecimal,
  ADDRESS_ZERO,
  FACTORY_ADDRESS,
  ONE_BI,
  createUser,
  createLiquidityPosition,
  ZERO_BD,
  BI_18,
  createLiquiditySnapshot
} from './helpers'

function isCompleteMint(mintId: string): boolean {
  let mintEvent = MintEvent.load(mintId);
  if (!mintEvent) {
    return false
  }
  return mintEvent.sender !== null // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return
  }

  let factory = HyperswapFactory.load(FACTORY_ADDRESS)
  if (!factory) {
    return
  }
  let transactionHash = event.transaction.hash.toHexString()

  // user stats
  let from = event.params.from
  createUser(from)
  let to = event.params.to
  createUser(to)

  let pair = Pair.load(event.address.toHexString())
  if (!pair) {
    return
  }
  let pairContract = PairContract.bind(event.address)

  // liquidity token amount being transfered
  let value = convertTokenToDecimal(event.params.value, BI_18)
  let transaction = Transaction.load(transactionHash)

  if (transaction == null) {
    transaction = new Transaction(transactionHash)
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.swaps = []
    transaction.burns = []
  }

  // load mints from transaction
  let mints = transaction.mints
  if (!mints) {
    return
  }

  // mint
  if (from.toHexString() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value)
    pair.save()

    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        event.transaction.hash
          .toHexString()
          .concat('-')
          .concat(BigInt.fromI32(mints.length).toString())
      )
      mint.pair = pair.id
      mint.to = to
      mint.liquidity = value
      mint.timestamp = transaction.timestamp
      mint.save()

      // update mints in transaction
      let newMints = transaction.mints
      if (newMints) {
        newMints.push(mint.id)
        transaction.mints = newMints
      }

      // save entities
      transaction.save()
      factory.save()
    }
  }

  // case where direct send first on Ftm withdrawls
  if (event.params.to.toHexString() == pair.id) {
    let burns = transaction.burns
    if (burns) {
      let burn = new BurnEvent(
        event.transaction.hash
          .toHexString()
          .concat('-')
          .concat(BigInt.fromI32(burns.length).toString())
      )
      burn.pair = pair.id
      burn.liquidity = value
      burn.timestamp = transaction.timestamp
      burn.to = event.params.to
      burn.sender = event.params.from
      burn.needsComplete = true
      burn.save()
      burns.push(burn.id)
      transaction.burns = burns
      transaction.save()
    }
  }

  // burn
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.from.toHexString() == pair.id) {
    pair.totalSupply = pair.totalSupply.minus(value)
    pair.save()

    // this is a new instance of a logical burn
    let burns = transaction.burns
    let burn: BurnEvent
    if (burns && burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1])
      if (currentBurn) {
        if (currentBurn.needsComplete) {
          burn = currentBurn as BurnEvent
        } else {
          burn = new BurnEvent(
            event.transaction.hash
              .toHexString()
              .concat('-')
              .concat(BigInt.fromI32(burns.length).toString())
          )
          burn.needsComplete = false
          burn.pair = pair.id
          burn.liquidity = value
          burn.timestamp = transaction.timestamp
        }
      } else {
        burn = new BurnEvent(
          event.transaction.hash
            .toHexString()
            .concat('-')
            .concat(BigInt.fromI32(burns.length).toString())
        )
        if (burn) {
          burn.needsComplete = false
          burn.pair = pair.id
          burn.liquidity = value
          burn.timestamp = transaction.timestamp
        }
      }
      // if this logical burn included a fee mint, account for this
      if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
        let mint = MintEvent.load(mints[mints.length - 1])
        if (mint) {
          burn.feeTo = mint.to
          burn.feeLiquidity = mint.liquidity
          // remove the logical mint
          store.remove('Mint', mints[mints.length - 1])
          // update the transaction
          mints.pop()
          transaction.mints = mints
          transaction.save()
        }
      }
      burn.save()
      // if accessing last one, replace it
      if (burn.needsComplete) {
        burns[burns.length - 1] = burn.id
      }
      // else add new one
      else {
        burns.push(burn.id)
      }
      transaction.burns = burns
      transaction.save()
    }
  }

  if (from.toHexString() != ADDRESS_ZERO && from.toHexString() != pair.id) {
    let fromUserLiquidityPosition = createLiquidityPosition(event.address, from)
    fromUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(from), BI_18)
    fromUserLiquidityPosition.save()
    createLiquiditySnapshot(fromUserLiquidityPosition, event)
  }

  if (event.params.to.toHexString() != ADDRESS_ZERO && to.toHexString() != pair.id) {
    let toUserLiquidityPosition = createLiquidityPosition(event.address, to)
    toUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(to), BI_18)
    toUserLiquidityPosition.save()
    createLiquiditySnapshot(toUserLiquidityPosition, event)
  }

  transaction.save()
}

export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex())
  if (!pair) {
    return
  }
  let token0 = Token.load(pair.token0)
  if (!token0) {
    return
  }
  let token1 = Token.load(pair.token1)
  if (!token1) {
    return
  }
  let hyperswap = HyperswapFactory.load(FACTORY_ADDRESS)
  if (!hyperswap) {
    return
  }

  // reset factory liquidity by subtracting onluy tarcked liquidity
  hyperswap.totalLiquidityFTM = hyperswap.totalLiquidityFTM.minus(pair.trackedReserveFTM as BigDecimal)

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0)
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1)

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals)
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals)

  if (pair.reserve1.notEqual(ZERO_BD))
    pair.token0Price = pair.reserve0.div(pair.reserve1)
  else
    pair.token0Price = ZERO_BD
  if (pair.reserve0.notEqual(ZERO_BD))
    pair.token1Price = pair.reserve1.div(pair.reserve0)
  else
    pair.token1Price = ZERO_BD

  pair.save()

  // update FTM price now that reserves could have changed
  let bundle = Bundle.load('1')
  if (bundle) {
    bundle.ftmPrice = getFtmPriceInUSD()
    bundle.save()

    token0.derivedFTM = findFtmPerToken(token0 as Token)
    token1.derivedFTM = findFtmPerToken(token1 as Token)
    token0.save()
    token1.save()

    // get tracked liquidity - will be 0 if neither is in whitelist
    let trackedLiquidityFTM: BigDecimal
    if (bundle.ftmPrice.notEqual(ZERO_BD)) {
      trackedLiquidityFTM = getTrackedLiquidityUSD(pair.reserve0, token0 as Token, pair.reserve1, token1 as Token).div(
        bundle.ftmPrice
      )
    } else {
      trackedLiquidityFTM = ZERO_BD
    }

    // use derived amounts within pair
    pair.trackedReserveFTM = trackedLiquidityFTM
    pair.reserveFTM = pair.reserve0
      .times(token0.derivedFTM as BigDecimal)
      .plus(pair.reserve1.times(token1.derivedFTM as BigDecimal))
    pair.reserveUSD = pair.reserveFTM.times(bundle.ftmPrice)

    // use tracked amounts globally
    hyperswap.totalLiquidityFTM = hyperswap.totalLiquidityFTM.plus(trackedLiquidityFTM)
    hyperswap.totalLiquidityUSD = hyperswap.totalLiquidityFTM.times(bundle.ftmPrice)

    // now correctly set liquidity amounts for each token
    token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0)
    token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1)
  }

  // save entities
  pair.save()
  hyperswap.save()
  token0.save()
  token1.save()
}

export function handleMint(event: Mint): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  if (!transaction) {
    return;
  }
  let mints = transaction.mints
  if (!mints) {
    return
  }
  let mint = MintEvent.load(mints[mints.length - 1])
  if (!mint) {
    return;
  }

  let pair = Pair.load(event.address.toHex())
  if (!pair) {
    return;
  }
  let hyperswap = HyperswapFactory.load(FACTORY_ADDRESS)
  if (!hyperswap) {
    return;
  }

  let token0 = Token.load(pair.token0)
  if (!token0) {
    return;
  }
  let token1 = Token.load(pair.token1)
  if (!token1) {
    return;
  }

  // update exchange info (except balances, sync will cover that)
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // get new amounts of USD and Ftm for tracking
  let bundle = Bundle.load('1')
  let derivedFTM0 = token0.derivedFTM;
  let derivedFTM1 = token1.derivedFTM;
  if (bundle && derivedFTM0 && derivedFTM1) {
    let amountTotalUSD = derivedFTM1
      .times(token1Amount)
      .plus(derivedFTM0.times(token0Amount))
      .times(bundle.ftmPrice)
    mint.amountUSD = amountTotalUSD as BigDecimal
  }

  // update txn counts
  pair.txCount = pair.txCount.plus(ONE_BI)
  hyperswap.txCount = hyperswap.txCount.plus(ONE_BI)

  // save entities
  token0.save()
  token1.save()
  pair.save()
  hyperswap.save()

  mint.sender = event.params.sender
  mint.amount0 = token0Amount as BigDecimal
  mint.amount1 = token1Amount as BigDecimal
  mint.logIndex = event.logIndex
  mint.save()

  // update the LP position
  let liquidityPosition = createLiquidityPosition(event.address, mint.to as Address)
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateHyperswapDayData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  if (!transaction) {
    return;
  }
  let burns = transaction.burns
  if (!burns) {
    return;
  }
  let burn = BurnEvent.load(burns[burns.length - 1])
  if (!burn) {
    return;
  }

  let pair = Pair.load(event.address.toHex())
  if (!pair) {
    return;
  }
  let hyperswap = HyperswapFactory.load(FACTORY_ADDRESS)
  if (!hyperswap) {
    return;
  }

  //update token info
  let token0 = Token.load(pair.token0)
  if (!token0) {
    return;
  }
  let token1 = Token.load(pair.token1)
  if (!token1) {
    return;
  }
  let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // get new amounts of USD and Ftm for tracking
  let bundle = Bundle.load('1')
  if (!bundle) {
    return;
  }
  let derivedFTM0 = token0.derivedFTM;
  if (!derivedFTM0) {
    return
  }
  let derivedFTM1 = token1.derivedFTM;
  if (!derivedFTM1) {
    return
  }
  let amountTotalUSD = derivedFTM1
    .times(token1Amount)
    .plus(derivedFTM0.times(token0Amount))
    .times(bundle.ftmPrice)

  // update txn counts
  hyperswap.txCount = hyperswap.txCount.plus(ONE_BI)
  pair.txCount = pair.txCount.plus(ONE_BI)

  // update global counter and save
  token0.save()
  token1.save()
  pair.save()
  hyperswap.save()

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal
  burn.amount1 = token1Amount as BigDecimal
  // burn.to = event.params.to
  burn.logIndex = event.logIndex
  burn.amountUSD = amountTotalUSD as BigDecimal
  burn.save()

  // update the LP position
  let liquidityPosition = createLiquidityPosition(event.address, burn.sender as Address)
  createLiquiditySnapshot(liquidityPosition, event)

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateHyperswapDayData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
}

export function handleSwap(event: Swap): void {
  let pair = Pair.load(event.address.toHexString())
  if (!pair) {
    return;
  }
  let token0 = Token.load(pair.token0)
  if (!token0) {
    return
  }
  let token1 = Token.load(pair.token1)
  if (!token1) {
    return
  }
  let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals)
  let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals)
  let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals)
  let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals)

  // totals for volume updates
  let amount0Total = amount0Out.plus(amount0In)
  let amount1Total = amount1Out.plus(amount1In)

  // Ftm/USD prices
  let bundle = Bundle.load('1')
  if (!bundle) {
    return
  }

  // get total amounts of derived USD and Ftm for tracking
  let derivedFTM0 = token0.derivedFTM;
  if (!derivedFTM0) {
    return
  }
  let derivedFTM1 = token1.derivedFTM;
  if (!derivedFTM1) {
    return
  }
  let derivedAmountFTM = derivedFTM1
    .times(amount1Total)
    .plus(derivedFTM0.times(amount0Total))
    .div(BigDecimal.fromString('2'))
  if (!derivedAmountFTM) {
    return
  }
  let derivedAmountUSD = derivedAmountFTM.times(bundle.ftmPrice)

  // only accounts for volume through white listed tokens
  let trackedAmountUSD = getTrackedVolumeUSD(amount0Total, token0 as Token, amount1Total, token1 as Token, pair as Pair)

  let trackedAmountFTM: BigDecimal
  if (bundle.ftmPrice.equals(ZERO_BD)) {
    trackedAmountFTM = ZERO_BD
  } else {
    trackedAmountFTM = trackedAmountUSD.div(bundle.ftmPrice)
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out))
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD)
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out))
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD)

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD)
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total)
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total)
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD)
  pair.txCount = pair.txCount.plus(ONE_BI)
  pair.save()

  // update global values, only used tracked amounts for volume
  let hyperswap = HyperswapFactory.load(FACTORY_ADDRESS)
  if (!hyperswap) {
    return;
  }
  hyperswap.totalVolumeUSD = hyperswap.totalVolumeUSD.plus(trackedAmountUSD)
  hyperswap.totalVolumeFTM = hyperswap.totalVolumeFTM.plus(trackedAmountFTM)
  hyperswap.untrackedVolumeUSD = hyperswap.untrackedVolumeUSD.plus(derivedAmountUSD)
  hyperswap.txCount = hyperswap.txCount.plus(ONE_BI)

  // save entities
  pair.save()
  token0.save()
  token1.save()
  hyperswap.save()

  let transaction = Transaction.load(event.transaction.hash.toHexString())
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString())
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.swaps = []
    transaction.burns = []
    transaction.save()
  }
  let swaps = transaction.swaps
  if (!swaps) {
    return
  }
  let swap = new SwapEvent(
    event.transaction.hash
      .toHexString()
      .concat('-')
      .concat(BigInt.fromI32(swaps.length).toString())
  )
  if (!swap) {
    return
  }
  // update swap event
  swap.pair = pair.id
  swap.timestamp = transaction.timestamp
  swap.sender = event.params.sender
  swap.amount0In = amount0In
  swap.amount1In = amount1In
  swap.amount0Out = amount0Out
  swap.amount1Out = amount1Out
  swap.to = event.params.to
  swap.logIndex = event.logIndex
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD
  swap.save()

  // update the transaction
  swaps.push(swap.id)
  transaction.swaps = swaps
  transaction.save()

  // update day entities
  updatePairDayData(event)
  updatePairHourData(event)
  updateHyperswapDayData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)

  let timestamp = event.block.timestamp.toI32()
  // daily info
  let dayID = timestamp / 86400
  let dayPairID = event.address
    .toHexString()
    .concat('-')
    .concat(BigInt.fromI32(dayID).toString())

  // hourly info
  let hourID = timestamp / 3600
  let hourPairID = event.address
    .toHexString()
    .concat('-')
    .concat(BigInt.fromI32(hourID).toString())

  // swap specific updating
  let hyperswapDayData = HyperswapDayData.load(dayID.toString())
  if (!hyperswapDayData) {
    return;
  }
  hyperswapDayData.dailyVolumeUSD = hyperswapDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  hyperswapDayData.dailyVolumeFTM = hyperswapDayData.dailyVolumeFTM.plus(trackedAmountFTM)
  hyperswapDayData.dailyVolumeUntracked = hyperswapDayData.dailyVolumeUntracked.plus(derivedAmountUSD)
  hyperswapDayData.save()

  // swap specific updating for pair
  let pairDayData = PairDayData.load(dayPairID)
  if (!pairDayData) {
    return;
  }
  pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total)
  pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total)
  pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD)
  pairDayData.save()

  // update hourly pair data
  let pairHourData = PairHourData.load(hourPairID)
  if (!pairHourData) {
    return;
  }
  pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total)
  pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total)
  pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD)
  pairHourData.save()

  // swap specific updating for token0
  let token0DayID = token0.id
    .toString()
    .concat('-')
    .concat(BigInt.fromI32(dayID).toString())
  let token0DayData = TokenDayData.load(token0DayID)
  if (!token0DayData) {
    return;
  }
  token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total)
  token0DayData.dailyVolumeFTM = token0DayData.dailyVolumeFTM.plus(amount0Total.times(token1.derivedFTM as BigDecimal))
  token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
    amount0Total.times(token0.derivedFTM as BigDecimal).times(bundle.ftmPrice)
  )
  token0DayData.save()

  // swap specific updating
  let token1DayID = token1.id
    .toString()
    .concat('-')
    .concat(BigInt.fromI32(dayID).toString())
  let token1DayData = TokenDayData.load(token1DayID)
  
  if (!token1DayData) {
    return;
  }
  token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total)
  token1DayData.dailyVolumeFTM = token1DayData.dailyVolumeFTM.plus(amount1Total.times(token1.derivedFTM as BigDecimal))
  token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
    amount1Total.times(token1.derivedFTM as BigDecimal).times(bundle.ftmPrice)
  )
  token1DayData.save()
}
