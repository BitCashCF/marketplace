import BN from 'bn.js'
import { Address } from 'web3x-es/address'
import { toBN, toWei } from 'web3x-es/utils'

import { ERC721 } from '../../../contracts/ERC721'
import { ContractFactory } from '../../contract/ContractFactory'
import {
  NFT,
  NFTCategory,
  NFTsFetchParams,
  NFTsCountParams
} from '../../nft/types'
import { Order, OrderStatus } from '../../order/types'
import { Account } from '../../account/types'
import { getNFTId } from '../../nft/utils'
import { TokenConverter } from '../TokenConverter'
import { MarketplacePrice } from '../MarketplacePrice'
import { NFTService as NFTServiceInterface } from '../services'
import { Vendors, TransferType } from '../types'
import { ContractService } from './ContractService'
import { SuperRareAsset, SuperRareOrder, SuperRareOwner } from './types'
import { superRareAPI, MAX_QUERY_SIZE } from './api'

export class NFTService implements NFTServiceInterface<Vendors.SUPER_RARE> {
  private tokenConverter: TokenConverter
  private marketplacePrice: MarketplacePrice
  private oneEthInWei: BN

  constructor() {
    this.tokenConverter = new TokenConverter()
    this.marketplacePrice = new MarketplacePrice()
    this.oneEthInWei = new BN('1000000000000000000') // 10 ** 18
  }

  async fetch(params: NFTsFetchParams) {
    let remoteNFTs: SuperRareAsset[]
    let remoteOrders: SuperRareOrder[]

    if ((params.address && !params.onlyOnSale) || !params.onlyOnSale) {
      const result = await Promise.all([
        superRareAPI.fetchNFTs(params),
        superRareAPI.fetchOrders(params)
      ])
      remoteNFTs = result[0]
      remoteOrders = result[1]
    } else {
      remoteOrders = await superRareAPI.fetchOrders(params)
      remoteNFTs = remoteOrders.map(order => order.asset)
    }

    const nfts: NFT<Vendors.SUPER_RARE>[] = []
    const accounts: Account[] = []
    const orders: Order[] = []

    const total = await this.count(params)
    const oneEthInMANA = await this.getOneEthInMANA()

    for (const asset of remoteNFTs) {
      const nft = this.toNFT(asset)

      const remoteOrder = remoteOrders.find(
        order => order.asset.id === asset.id
      )

      if (remoteOrder) {
        const order = this.toOrder(remoteOrder, oneEthInMANA)

        nft.activeOrderId = order.id
        order.nftId = nft.id

        orders.push(order)
      }

      let account = accounts.find(account => account.id === asset.owner.address)
      if (!account) {
        account = this.toAccount(asset.owner)
      }
      account.nftIds.push(nft.id)

      nfts.push(nft)
      accounts.push(account)
    }

    return [nfts, accounts, orders, total] as const
  }

  async count(countParams: NFTsCountParams) {
    const params: NFTsFetchParams = {
      ...countParams,
      first: MAX_QUERY_SIZE,
      skip: 0
    }

    let remoteElements
    if (params.address) {
      remoteElements = await superRareAPI.fetchNFTs(params)
    } else {
      remoteElements = await superRareAPI.fetchOrders(params)
    }

    return remoteElements.length
  }

  async fetchOne(contractAddress: string, tokenId: string) {
    const [remoteNFT, remoteOrder, oneEthInMANA] = await Promise.all([
      superRareAPI.fetchNFT(contractAddress, tokenId),
      superRareAPI.fetchOrder(contractAddress, tokenId),
      this.getOneEthInMANA()
    ])

    const nft = this.toNFT(remoteNFT)
    let order: Order | undefined

    if (remoteOrder) {
      order = this.toOrder(remoteOrder, oneEthInMANA)

      nft.activeOrderId = order.id
      order.nftId = nft.id
    }

    return [nft, order] as const
  }

  async transfer(
    fromAddress: string,
    toAddress: string,
    nft: NFT<Vendors.SUPER_RARE>
  ) {
    if (!fromAddress) {
      throw new Error('Invalid address. Wallet must be connected.')
    }
    const from = Address.fromString(fromAddress)
    const to = Address.fromString(toAddress)

    const erc721 = ContractFactory.build(ERC721, nft.contractAddress)
    const transferType = new ContractService().getTransferType(
      nft.contractAddress
    )
    let transaction

    switch (transferType) {
      case TransferType.TRANSFER:
        transaction = erc721.methods.transfer(to, nft.tokenId)
        break
      case TransferType.SAFE_TRANSFER_FROM:
      default:
        transaction = erc721.methods.transferFrom(from, to, nft.tokenId)
        break
    }

    return transaction.send({ from }).getTxHash()
  }

  toNFT(asset: SuperRareAsset): NFT<Vendors.SUPER_RARE> {
    return {
      id: getNFTId(asset.contractAddress, asset.id.toString()),
      tokenId: asset.id.toString(),
      contractAddress: asset.contractAddress,
      activeOrderId: '',
      owner: asset.owner.address,
      name: asset.name,
      image: asset.image,
      url: asset.url,
      data: {
        description: asset.description
      },
      category: NFTCategory.ART,
      vendor: Vendors.SUPER_RARE
    }
  }

  toOrder(order: SuperRareOrder, oneEthInMANA: string): Order {
    const { asset, taker } = order

    const totalWei = this.marketplacePrice.addFee(order.amountWithFee)
    const weiPrice = toBN(totalWei).mul(toBN(oneEthInMANA))
    const price = weiPrice.div(this.oneEthInWei)

    return {
      id: `${Vendors.SUPER_RARE}-order-${asset.id}`,
      nftId: asset.id.toString(),
      category: NFTCategory.ART,
      nftAddress: asset.contractAddress,
      marketAddress: order.marketContractAddress,
      owner: asset.owner.address,
      buyer: taker ? taker.address : null,
      price: price.toString(10),
      ethPrice: order.amountWithFee.toString(),
      status: OrderStatus.OPEN,
      createdAt: order.timestamp,
      updatedAt: order.timestamp
    }
  }

  toAccount(account: SuperRareOwner): Account {
    return {
      id: account.address,
      address: account.address,
      nftIds: []
    }
  }

  private async getOneEthInMANA() {
    const mana = await this.tokenConverter.marketEthToMANA(1)
    return toWei(mana.toString(), 'ether')
  }
}
