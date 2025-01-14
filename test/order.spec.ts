import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'

import { SeaportGossipNode } from '../dist/index.js'
import { orderToJSON } from '../dist/util/convert.js'
import { ErrorInvalidAddress } from '../dist/util/errors.js'
import { timestampNow, zeroAddress } from '../dist/util/helpers.js'
import {
  compareOrdersByCurrentPrice,
  deriveOrderHash,
} from '../dist/util/order.js'
import {
  AuctionType,
  OrderFilter,
  OrderSort,
  Side,
} from '../dist/util/types.js'

import invalidBasicOrders from './testdata/orders/basic-invalid.json' assert { type: 'json' }
import validBasicOrders from './testdata/orders/basic-valid.json' assert { type: 'json' }
import {
  randomOrder,
  setOrderAuctionType,
  simulateOrderFulfillment,
  simulateOrderValidation,
  truncateTables,
} from './util/db.js'
import { MockProvider } from './util/provider.js'

import type { GetOrdersOpts } from '../dist/query/order.js'
import type { OrderWithItems } from '../dist/util/types.js'

chai.use(chaiAsPromised)

describe('Orders', () => {
  const opts = {
    web3Provider: new MockProvider('mainnet') as any,
    logLevel: 'off',
  }
  let node = new SeaportGossipNode(opts)

  beforeEach(async () => {
    await node.start()
  })

  afterEach(async () => {
    await truncateTables(node)
    await node.stop()
  })

  it('should add and get orders', async () => {
    const numValid = await node.addOrders(validBasicOrders)
    expect(numValid).to.eq(8)

    /* Side.SELL (default) */
    let orders = await node.getOrders(
      '0x3F53082981815Ed8142384EDB1311025cA750Ef1'
    )
    expect(orders.length).to.eq(1)
    orders = await node.getOrders(
      '0x3F53082981815Ed8142384EDB1311025cA750Ef1',
      { side: Side.SELL }
    )
    expect(orders.length).to.eq(1)
    orders = await node.getOrders('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
    expect(orders.length).to.eq(2)

    /* Side.BUY */
    orders = await node.getOrders(
      '0x3F53082981815Ed8142384EDB1311025cA750Ef1',
      { side: Side.BUY }
    )
    expect(orders.length).to.eq(3)
    orders = await node.getOrders(
      '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d',
      { side: Side.BUY }
    )
    expect(orders.length).to.eq(2)

    /* Zero address: orders with ETH token */
    orders = await node.getOrders(zeroAddress, { side: Side.SELL })
    expect(orders.length).to.eq(2)
    orders = await node.getOrders(zeroAddress, { side: Side.BUY })
    expect(orders.length).to.eq(6)

    await expect(node.getOrders('0xinvalid')).to.eventually.be.rejectedWith(
      ErrorInvalidAddress
    )
  })

  it('should not add invalid orders', async () => {
    const numValid = await node.addOrders(invalidBasicOrders as any)
    expect(numValid).to.eq(0)

    const orders = await node.getOrders(
      '0x3F53082981815Ed8142384EDB1311025cA750Ef1'
    )
    expect(orders.length).to.eq(0)
  })

  it('should return node stats', async () => {
    const stats = await node.stats()
    expect(stats).to.deep.eq({})
  })

  it('should get orders with count and offset options', async () => {
    await node.addOrders(validBasicOrders)

    const contractAddr = '0x3F53082981815Ed8142384EDB1311025cA750Ef1'

    const getOpts = { count: 3, offset: 0 }
    const orders = await node.getOrders(contractAddr, getOpts)

    const offsetGetOpts = { count: 2, offset: 1 }
    const offsetOrders = await node.getOrders(contractAddr, offsetGetOpts)

    expect(orders.slice(1)).to.deep.eq(offsetOrders)
  })

  it('should get orders with sort and filter options', async () => {
    await node.addOrders(validBasicOrders)

    let contractAddr = '0x3F53082981815Ed8142384EDB1311025cA750Ef1'

    for (const side of [Side.BUY, Side.SELL]) {
      /* Test sort options */

      // Default sort: NEWEST
      let getOpts: GetOrdersOpts = { side }
      const ordersDefaultSort = await node.getOrders(contractAddr, getOpts)
      let orderMetadata = await node.prisma.orderMetadata.findMany({
        where: {
          OR: ordersDefaultSort.map((o) => ({ orderHash: deriveOrderHash(o) })),
        },
        orderBy: { createdAt: 'desc' },
      })
      expect(ordersDefaultSort.map((o) => deriveOrderHash(o))).to.deep.eq(
        orderMetadata.map((o) => o.orderHash)
      )

      getOpts = { side, sort: OrderSort.NEWEST }
      let orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.deep.eq(ordersDefaultSort)

      getOpts = { side, sort: OrderSort.OLDEST }
      orders = await node.getOrders(contractAddr, getOpts)
      orderMetadata = await node.prisma.orderMetadata.findMany({
        where: {
          OR: ordersDefaultSort.map((o) => ({ orderHash: deriveOrderHash(o) })),
        },
        orderBy: { createdAt: 'asc' },
      })
      expect(orders.map((o) => deriveOrderHash(o))).to.deep.eq(
        orderMetadata.map((o) => o.orderHash)
      )

      getOpts = { side, sort: OrderSort.ENDING_SOON }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.deep.eq(orders.sort((a, b) => b.endTime - a.endTime))

      getOpts = { side, sort: OrderSort.PRICE_ASC }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.deep.eq(
        orders.sort(compareOrdersByCurrentPrice(side, OrderSort.PRICE_ASC))
      )

      getOpts = { side, sort: OrderSort.PRICE_DESC }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.deep.eq(
        orders.sort(compareOrdersByCurrentPrice(side, OrderSort.PRICE_DESC))
      )

      let order = await randomOrder(node.prisma)
      await simulateOrderFulfillment(node.prisma, order.hash, '1000000')
      getOpts = { side, sort: OrderSort.RECENTLY_FULFILLED, count: 1 }
      const itemSide = side === Side.BUY ? 'consideration' : 'offer'
      orders = await node.getOrders(order[itemSide][0].token, getOpts)
      expect(orders).to.deep.eq([orderToJSON(order)])

      order = await randomOrder(node.prisma)
      await simulateOrderValidation(node.prisma, order.hash, true)
      getOpts = { side, sort: OrderSort.RECENTLY_VALIDATED, count: 1 }
      orders = await node.getOrders(order[itemSide][0].token, getOpts)
      expect(orders).to.deep.eq([orderToJSON(order)])

      order = await randomOrder(node.prisma)
      await simulateOrderFulfillment(node.prisma, order.hash, '100000000')
      getOpts = { side, sort: OrderSort.HIGHEST_LAST_SALE, count: 1 }
      orders = await node.getOrders(order[itemSide][0].token, getOpts)
      expect(orders).to.deep.eq([orderToJSON(order)])

      /* Test filter options */

      // Default filter: none
      getOpts = { side, filter: {} }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.deep.eq(ordersDefaultSort)

      // should ignore filter arg of false
      getOpts = { side, filter: { [OrderFilter.SINGLE_ITEM]: false } }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.deep.eq(ordersDefaultSort)

      const offererAddr = '0xEA674fdDe714fd979de3EdF0F56AA9716B898ec8'
      getOpts = { side, filter: { [OrderFilter.OFFERER_ADDRESS]: offererAddr } }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every((o) => o.offerer === offererAddr)
      )

      contractAddr = '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d'
      const tokenId = '75'
      getOpts = {
        side,
        filter: { [OrderFilter.TOKEN_ID]: tokenId },
      }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every((o) =>
          o[itemSide].some((item) => item.identifierOrCriteria === tokenId)
        )
      )

      order = await randomOrder(node.prisma)
      await setOrderAuctionType(node.prisma, order.hash, AuctionType.BASIC)
      getOpts = { side, filter: { [OrderFilter.BUY_NOW]: true } }
      orders = await node.getOrders(order[itemSide][0].token, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every(
          async (o) =>
            o.startTime >= timestampNow() && o.auctionType === AuctionType.BASIC
        )
      )

      getOpts = {
        side,
        filter: {
          [OrderFilter.BUY_NOW]: true,
          [OrderFilter.OFFERER_ADDRESS]: order.offerer,
        },
      }
      orders = await node.getOrders(order[itemSide][0].token, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every(
          async (o) =>
            o.startTime >= timestampNow() &&
            o.auctionType === AuctionType.BASIC &&
            o.offerer === order.offerer
        )
      )

      await setOrderAuctionType(node.prisma, order.hash, AuctionType.ENGLISH)
      getOpts = {
        side,
        filter: {
          [OrderFilter.ON_AUCTION]: true,
        },
      }
      orders = await node.getOrders(order[itemSide][0].token, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every(
          async (o) =>
            o.startTime >= timestampNow() &&
            o.auctionType === AuctionType.ENGLISH
        )
      )

      getOpts = {
        side,
        filter: {
          [OrderFilter.ON_AUCTION]: true,
          [OrderFilter.OFFERER_ADDRESS]: order.offerer,
        },
      }
      orders = await node.getOrders(order[itemSide][0].token, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every(
          async (o) =>
            o.startTime >= timestampNow() &&
            o.auctionType === AuctionType.ENGLISH &&
            o.offerer === order.offerer
        )
      )

      getOpts = { side, filter: { [OrderFilter.SINGLE_ITEM]: true } }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every(async (o) => o[itemSide].length === 1)
      )

      getOpts = { side, filter: { [OrderFilter.BUNDLES]: true } }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every(async (o) => o[itemSide].length > 1)
      )

      const wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
      getOpts = { side, filter: { [OrderFilter.CURRENCY]: wethAddress } }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every((o) =>
          o[itemSide].some((item) => item.token === wethAddress)
        )
      )

      getOpts = {
        side,
        filter: {
          [OrderFilter.CURRENCY]: wethAddress,
          [OrderFilter.BUY_NOW]: true,
        },
      }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every(
          async (o) =>
            o.startTime >= timestampNow() &&
            o.auctionType === AuctionType.BASIC &&
            o[itemSide].some((item) => item.token === wethAddress)
        )
      )

      /* Test sort and filter options together */

      getOpts = {
        side,
        sort: OrderSort.ENDING_SOON,
        filter: {
          [OrderFilter.OFFERER_ADDRESS]: order.offerer,
          [OrderFilter.BUY_NOW]: true,
        },
      }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.deep.eq(orders.sort((a, b) => b.endTime - a.endTime))
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every(
          async (o) =>
            o.startTime >= timestampNow() &&
            o.auctionType === AuctionType.BASIC &&
            o.offerer === order.offerer
        )
      )

      getOpts = {
        side,
        sort: OrderSort.PRICE_DESC,
        filter: { [OrderFilter.CURRENCY]: wethAddress },
      }
      orders = await node.getOrders(contractAddr, getOpts)
      expect(orders).to.deep.eq(
        orders.sort(compareOrdersByCurrentPrice(side, OrderSort.PRICE_DESC))
      )
      expect(orders).to.satisfy((allOrders: OrderWithItems[]) =>
        allOrders.every((o) =>
          o[itemSide].some((item) => item.token === wethAddress)
        )
      )
    }
  })

  it('should not exceed the max order limits', async () => {
    await node.stop()
    node = new SeaportGossipNode({
      ...opts,
      maxOrders: 2,
      maxOrdersPerOfferer: 2,
    })
    await node.start()
    let numValid = await node.addOrders(validBasicOrders.slice(0, 3))
    expect(numValid).to.eq(2)
    numValid = await node.addOrders(validBasicOrders.slice(3, 4))
    expect(numValid).to.eq(0)
    await truncateTables(node)
    const ordersBySameOfferer = validBasicOrders
      .slice(0, 3)
      .map((o) => ({ ...o, offerer: validBasicOrders[0].offerer }))
    numValid = await node.addOrders(ordersBySameOfferer)
    expect(numValid).to.eq(2)
  })
})
