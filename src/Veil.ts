const { camelizeKeys } = require("humps");
import some = require("lodash/some");
import getProvider from "./provider";
import { BigNumber } from "@0x/utils";
import { Provider, Order as ZeroExOrder } from "@0x/order-utils";
import { signOrder } from "./0x";
import fetch from "node-fetch";
import { VeilError } from "./errors";
import { Web3Wrapper } from "@0x/web3-wrapper";
import { utils } from "ethers";

export interface Market {
  slug: string;
  uid: string;
  endsAt: number;
  shortToken: string;
  longToken: string;
  numTicks: string;
  minPrice: string;
  maxPrice: string;
  orders?: Order[];
  index: string;
  limitPrice: string;
  type: string;
}

export interface Order {
  uid: string;
  price: string;
  side: "buy" | "sell";
  tokenAmount: string;
  tokenAmountUnfilled: string;
  status: "open" | "filled" | "canceled";
  tokenType: "short" | "long";
}

export interface OrderFill {
  uid: string;
  price: string;
  side: "buy" | "sell";
  tokenAmount: string;
  status: "pending" | "completed";
  createdAt: number;
}

export interface OrderBookRow {
  price: string;
  tokenAmount: string;
}

export interface Quote {
  uid: string;
  zeroExOrder: ZeroExOrder;
}

export interface DataFeedEntry {
  value: string;
  timestamp: number;
}

export interface DataFeed {
  uid: string;
  name: string;
  description: string;
  denomination: string;
  entries: DataFeedEntry[];
}

export interface Page<T> {
  results: T[];
  page: number;
  pageSize: number;
  total: number;
}

const API_HOST_DEFAULT = "https://api.kovan.veil.market";

const TEN_18 = new BigNumber(10).toPower(18);
export function toWei(amount: number) {
  return new BigNumber(amount.toString()).mul(TEN_18);
}

export function fromWei(amount: BigNumber | string) {
  return new BigNumber(amount.toString()).div(TEN_18);
}

export function toShares(amount: number, numTicks: string | number) {
  return new BigNumber(amount.toString())
    .mul(TEN_18)
    .div(new BigNumber(numTicks));
}

export function fromShares(
  amount: BigNumber | string,
  numTicks: string | number
) {
  return new BigNumber(amount.toString())
    .mul(new BigNumber(numTicks))
    .div(TEN_18);
}

export function encodeParams(params: Object) {
  return Object.entries(params)
    .map(kv => kv.map(encodeURIComponent).join("="))
    .join("&");
}

export default class Veil {
  provider: Provider;
  apiHost: string;
  address: string;
  jwt: string;
  isSetup = false;

  constructor(
    mnemonic?: string,
    address?: string,
    apiHost: string = API_HOST_DEFAULT
  ) {
    if (mnemonic) this.provider = getProvider(mnemonic);
    if (address) this.address = address.toLowerCase();
    this.apiHost = apiHost;
  }

  async fetch(
    url: string,
    params: any = {},
    method: "POST" | "GET" | "DELETE" = "GET"
  ) {
    if (method === "GET") url = url + "?" + encodeParams(params);
    const response = await fetch(url, {
      method,
      body: method !== "GET" ? JSON.stringify(params) : undefined,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.jwt ? { Authorization: `Bearer ${this.jwt}` } : {})
      }
    });
    const json = await response.json();
    if (json.errors) throw new VeilError(json.errors, url);
    return camelizeKeys(json.data);
  }

  async setup() {
    if (!this.jwt) await this.authenticate();
    this.isSetup = true;
  }

  async authenticate() {
    if (!this.provider || !this.address)
      throw new VeilError([
        "You tried calling an authenticated method without passing a mnemonic and address to the Veil constructor"
      ]);
    const challenge = await this.createSessionChallenge();
    const web3 = new Web3Wrapper(this.provider);
    const signature = await web3.signMessageAsync(
      this.address,
      utils.hexlify(utils.toUtf8Bytes(challenge.uid))
    );
    const session = await this.createSession({
      signature,
      challengeUid: challenge.uid,
      message: challenge.uid
    });
    this.jwt = session.token;
    return true;
  }

  async createSessionChallenge() {
    const url = `${this.apiHost}/api/v1/session_challenges`;
    const challenge: { uid: string } = await this.fetch(url, {}, "POST");
    return challenge;
  }

  async createSession(params: {
    challengeUid: string;
    signature: string;
    message: string;
  }) {
    const url = `${this.apiHost}/api/v1/sessions`;
    const session: { token: string } = await this.fetch(url, params, "POST");
    return session;
  }

  async getMarkets(
    params: {
      channel?: string;
      status?: "open" | "resolved";
      page?: number;
    } = {}
  ) {
    const url = `${this.apiHost}/api/v1/markets`;
    const page: Page<Market> = await this.fetch(url, params);
    return page;
  }

  async createOrder(quote: Quote, options: { postOnly?: boolean } = {}) {
    if (!this.isSetup) await this.setup();

    const signedOrder = await signOrder(this.provider, quote.zeroExOrder);
    const params = {
      order: {
        zeroExOrder: signedOrder,
        quoteUid: quote.uid,
        ...options
      }
    };
    while (true) {
      try {
        const url = `${this.apiHost}/api/v1/orders`;
        const order: Order = await this.fetch(url, params, "POST");
        return order;
      } catch (e) {
        if (some(e.errors, (err: any) => err.message.match("jwt expired"))) {
          await this.authenticate();
        } else throw e;
      }
    }
  }

  async createQuote(
    market: Market,
    side: "buy" | "sell",
    tokenType: "long" | "short",
    amount: number | BigNumber,
    price: number | BigNumber
  ) {
    if (!this.isSetup) await this.setup();

    const zero = new BigNumber(0);
    const numTicks = new BigNumber(market.numTicks);
    if (typeof amount === "number") amount = toShares(amount, market.numTicks);
    amount = amount.round();

    if (typeof price === "number")
      price = new BigNumber(price.toString()).mul(numTicks);
    if (price.lt(zero)) price = zero;
    if (price.gt(numTicks)) price = numTicks;
    price = price.round();

    const token = tokenType === "long" ? market.longToken : market.shortToken;

    const params = {
      quote: {
        side,
        token,
        tokenAmount: amount.toString(),
        price: price.toString(),
        type: "limit"
      }
    };

    while (true) {
      try {
        const url = `${this.apiHost}/api/v1/quotes`;
        const quote: Quote = await this.fetch(url, params, "POST");
        return quote;
      } catch (e) {
        if (some(e.errors, (err: any) => err.message.match("jwt expired"))) {
          await this.authenticate();
        } else throw e;
      }
    }
  }

  async cancelOrder(uid: string) {
    if (!this.isSetup) await this.setup();

    while (true) {
      try {
        const url = `${this.apiHost}/api/v1/orders/${uid}`;
        const order: Order = await this.fetch(url, {}, "DELETE");
        return order;
      } catch (e) {
        if (some(e.errors, (err: any) => err.message.match("jwt expired"))) {
          await this.authenticate();
        } else throw e;
      }
    }
  }

  async getUserOrders(market: Market, options?: { page?: number }) {
    if (!this.isSetup) await this.setup();

    while (true) {
      try {
        const url = `${this.apiHost}/api/v1/orders`;
        const page: Page<Order> = await this.fetch(url, {
          ...options,
          market: market.slug
        });
        return page;
      } catch (e) {
        if (some(e.errors, (err: any) => err.message.match("jwt expired"))) {
          await this.authenticate();
        } else throw e;
      }
    }
  }

  async getBids(
    market: Market,
    tokenType: "long" | "short",
    options?: { page?: number }
  ) {
    if (tokenType !== "long" && tokenType !== "short")
      throw new Error(
        `Invalid tokenType: "${tokenType}". Must be either "long" or "short".`
      );
    const url = `${this.apiHost}/api/v1/markets/${
      market.slug
    }/${tokenType}/bids`;
    const page: Page<OrderBookRow> = await this.fetch(url, options);
    return page;
  }

  async getAsks(
    market: Market,
    tokenType: "long" | "short",
    options?: { page?: number }
  ) {
    if (tokenType !== "long" && tokenType !== "short")
      throw new Error(
        `Invalid tokenType: "${tokenType}". Must be either "long" or "short".`
      );
    const url = `${this.apiHost}/api/v1/markets/${
      market.slug
    }/${tokenType}/asks`;
    const page: Page<OrderBookRow> = await this.fetch(url, options);
    return page;
  }

  async getOrderFills(
    market: Market,
    tokenType: "long" | "short",
    options?: { page?: number }
  ) {
    if (tokenType !== "long" && tokenType !== "short")
      throw new Error(
        `Invalid tokenType: "${tokenType}". Must be either "long" or "short".`
      );
    const url = `${this.apiHost}/api/v1/markets/${
      market.slug
    }/${tokenType}/order_fills`;
    const page: Page<OrderFill> = await this.fetch(url, options);
    return page;
  }

  async getDataFeed(dataFeedSlug: string, scope: "day" | "month" = "month") {
    const url = `${this.apiHost}/api/v1/data_feeds/${dataFeedSlug}`;
    const params = { scope };
    const dataFeed: DataFeed = await this.fetch(url, params);
    return dataFeed;
  }

  getScalarRange(market: Market): [number, number] {
    if (!market.minPrice || !market.maxPrice)
      throw new Error("Market does not have min and max price");
    return [
      fromWei(market.minPrice).toNumber(),
      fromWei(market.maxPrice).toNumber()
    ];
  }

  async getMarket(slug: string) {
    const url = `${this.apiHost}/api/v1/markets/${slug}`;
    const market: Market = await this.fetch(url);
    if (!market) throw new Error(`Market not found: ${slug}`);
    return market;
  }
}
