import solc from 'solc';
import type { Abi, Hex } from 'viem';

/** Minimal ERC-20 plus a toy "DEX router" that pulls tokens via transferFrom and pays out native coin. */
export const CONTRACTS_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TestToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "ERC20: insufficient allowance");
        allowance[from][msg.sender] = a - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "ERC20: insufficient balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

contract TestRouter {
    event Swapped(address indexed user, address indexed token, uint256 amountIn, uint256 amountOut);

    /// Pulls amountIn tokens from the caller and pays amountIn / 1000 in native coin.
    function swapToNative(address token, uint256 amountIn) external {
        require(TestToken(token).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        uint256 out = amountIn / 1000;
        (bool ok, ) = msg.sender.call{value: out}("");
        require(ok, "payout failed");
        emit Swapped(msg.sender, token, amountIn, out);
    }

    receive() external payable {}
}
`;

export interface CompiledContract {
  abi: Abi;
  bytecode: Hex;
}

let cache: Record<string, CompiledContract> | undefined;

export function compileContracts(): { TestToken: CompiledContract; TestRouter: CompiledContract } {
  if (!cache) {
    const input = {
      language: 'Solidity',
      sources: { 'Test.sol': { content: CONTRACTS_SOURCE } },
      settings: {
        // Stay on an EVM version every anvil hardfork supports.
        evmVersion: 'cancun',
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      },
    };
    const out = JSON.parse(solc.compile(JSON.stringify(input))) as {
      errors?: { severity: string; formattedMessage: string }[];
      contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
    };
    const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
    cache = {};
    for (const [name, c] of Object.entries(out.contracts['Test.sol'])) {
      cache[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
    }
  }
  return { TestToken: cache.TestToken, TestRouter: cache.TestRouter };
}
